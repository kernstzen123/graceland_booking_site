import 'server-only';
import crypto from 'crypto';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import QRCode from 'qrcode';
import { supabase } from './supabase';
import { createQrToken } from './qr-token';
import { escapeHtml, renderEmailLayout } from './email-layout';
import { BOOKING_CARD_SELECT, buildBookingCard, type BookingCardRow } from './booking-card';
import { bookingEmailBody, createBookingPdf, formatVisitDate, wrapPdfText } from './booking-email';
import { bookingScanUrl, ensureBookingQrToken } from './booking-qr';
import { getBusinessSettings } from './business-settings';
import { sendEmail } from './mailer';
import { spotLabel } from './seating';

type BookingItem = {
  quantity: number;
  package_id: string | null;
  hut_id: string | null;
  metadata: { name?: string; itemId?: string; isPerson?: boolean; attendeeNames?: Array<{ firstName: string; lastName: string }> } | null;
  packages?: { name?: string } | null;
  huts?: { name?: string } | null;
  bookings?: { visit_date?: string; customer_id?: string; voucher_credit_id?: string | null; status?: string } | null;
};

/**
 * Create the booking's tickets (reusing any that already exist) and email them.
 * Pass { sendEmail: false } to only create them, e.g. for walk-in sales without an email address.
 */
export async function generateTicketsAndSendEmail(bookingId: string, customerEmail: string, customerName: string, options: { sendEmail?: boolean } = {}) {
  const { data: existingTickets, error: existingTicketsError } = await supabase
    .from('tickets')
    .select('ticket_uid, qr_token, visit_date')
    .eq('booking_id', bookingId);
  if (existingTicketsError) throw new Error(`Could not load existing tickets: ${existingTicketsError.message}`);

  const { data: bookingItems, error: itemsError } = await supabase
    .from('booking_items')
    .select('*, bookings(visit_date, customer_id, voucher_credit_id, status), packages(name), huts(name)')
    .eq('booking_id', bookingId);
  if (itemsError) throw new Error(`Could not load booking items: ${itemsError.message}`);

  const items = (bookingItems || []) as BookingItem[];
  const { data: bookingSpots, error: spotsError } = await supabase
    .from('booking_spots')
    .select('venue_spots(number,type)')
    .eq('booking_id', bookingId);
  if (spotsError) throw new Error(`Could not load booking seating: ${spotsError.message}`);

  const { data: existingMeals, error: existingMealsError } = await supabase.from('meal_vouchers').select('meal_uid, qr_token, visit_date, meal_name, specials(title)').eq('booking_id', bookingId);
  if (existingMealsError) throw new Error(`Could not load meal vouchers: ${existingMealsError.message}`);
  const { data: bookingSpecials, error: bookingSpecialsError } = await supabase.from('booking_specials').select('special_id, quantity, snapshot').eq('booking_id', bookingId);
  if (bookingSpecialsError) throw new Error(`Could not load booking specials: ${bookingSpecialsError.message}`);
  const { data: settings } = await supabase.from('special_settings').select('meal_name').eq('id', 1).maybeSingle();
  const mealName = settings?.meal_name || 'Free Meal';

  const seatingLabel = (bookingSpots || []).map((row) => {
    const spot = Array.isArray(row.venue_spots) ? row.venue_spots[0] : row.venue_spots;
    if (!spot?.number) return null;
    return spotLabel(spot.type, spot.number);
  }).filter(Boolean).join(', ');
  const { names: displayNames, attendeeFullNames } = buildTicketDisplayNames(items, seatingLabel);
  const voucherCreditId = items.find(item => item.bookings?.voucher_credit_id)?.bookings?.voucher_credit_id;
  let voucherRemaining: number | null = null;
  if (voucherCreditId) {
    const { data: credit } = await supabase.from('booking_credits').select('remaining_balance').eq('id', voucherCreditId).maybeSingle();
    voucherRemaining = credit ? Number(credit.remaining_balance) : null;
  }

  // Meal vouchers come first and do not depend on the tickets: if an earlier
  // attempt saved the tickets but failed before the meal vouchers, a retry still
  // issues them (the tickets branch below returns early when tickets exist).
  type SpecialTitle = { title?: string } | null;
  let labelledMeals: Array<Record<string, unknown>> = (existingMeals || []).map(m => {
    const special = (Array.isArray(m.specials) ? m.specials[0] : m.specials) as SpecialTitle;
    return { ...m, display_name: `${m.meal_name || mealName} (${special?.title || 'Special'})` };
  });
  // Meal vouchers are only issued once the booking is paid: the kitchen redeems them without checking payment,
  // and an unpaid staff booking gets its tickets (for its booking QR code) before it is paid.
  const paidBooking = ['PAID', 'CONFIRMED'].includes(String(items[0]?.bookings?.status || ''));
  if (!existingMeals?.length && bookingSpecials?.length && paidBooking) {
    const visitDate = String(items[0]?.bookings?.visit_date);
    const newMeals: Array<Record<string, unknown>> = [];
    for (const bs of bookingSpecials) {
      const snapshot = bs.snapshot as { title?: string; free_meals?: number; included_meals?: Array<{ name: string; quantity: number }> };
      const mealDefinitions = snapshot.included_meals?.length
        ? snapshot.included_meals
        : (Number(snapshot.free_meals) > 0 ? [{ name: mealName, quantity: Number(snapshot.free_meals) }] : []);
      for (const mDef of mealDefinitions) {
        const totalMeals = Number(mDef.quantity) * Number(bs.quantity);
        for (let i = 0; i < totalMeals; i++) {
          const mealUid = `MEAL-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
          newMeals.push({
            booking_id: bookingId,
            special_id: bs.special_id,
            meal_uid: mealUid,
            qr_token: createQrToken(bookingId, mealUid, visitDate, 'meal'),
            visit_date: visitDate,
            meal_name: mDef.name,
            display_name: `${mDef.name} (${snapshot.title || 'Special'})`,
          });
        }
      }
    }
    if (newMeals.length) {
      const { error: insertMealsError } = await supabase.from('meal_vouchers').insert(newMeals.map(m => ({
        booking_id: m.booking_id, special_id: m.special_id, meal_uid: m.meal_uid, qr_token: m.qr_token, visit_date: m.visit_date, meal_name: m.meal_name,
      })));
      if (insertMealsError) throw new Error(`Could not create meal vouchers: ${insertMealsError.message}`);
      labelledMeals = newMeals;
    }
  }

  // ITNs can be retried after ticket creation. Reuse those tickets so a
  // failed email delivery can be retried without issuing duplicate tickets.
  if (existingTickets?.length) {
    const labelledTickets = existingTickets.map((ticket, index) => ({
      ...ticket,
      display_name: displayNames[index] || 'Entrance Ticket',
      attendee_name: attendeeFullNames[index] || '',
    }));
    if (options.sendEmail !== false) {
      await sendBookingEmail(bookingId, customerEmail, customerName, voucherRemaining, labelledMeals);
      await markTicketsEmailed(bookingId);
    }
    return labelledTickets;
  }

  const newTickets: Array<Record<string, unknown>> = [];
  let personIndex = 0;
  for (const item of items.filter(item => item.metadata?.isPerson === true || item.package_id)) {
    for (let i = 0; i < item.quantity; i++) {
      const ticketUid = `TKT-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
      const qrToken = createQrToken(bookingId, ticketUid, String(item.bookings?.visit_date));
      const displayName = displayNames[personIndex] || 'Entrance Ticket';
      const attendeeName = attendeeFullNames[personIndex] || '';
      personIndex++;
      newTickets.push({
        booking_id: bookingId, package_id: item.package_id, customer_id: item.bookings?.customer_id,
        ticket_uid: ticketUid, qr_token: qrToken, visit_date: item.bookings?.visit_date,
        display_name: displayName, attendee_name: attendeeName,
      });
    }
  }
  if (!newTickets.length) throw new Error(`No entrance tickets found for booking ${bookingId}`);

  const { error: insertError } = await supabase.from('tickets').insert(newTickets.map(ticket => ({
    booking_id: ticket.booking_id, package_id: ticket.package_id, customer_id: ticket.customer_id,
    ticket_uid: ticket.ticket_uid, qr_token: ticket.qr_token, visit_date: ticket.visit_date,
  })));
  if (insertError) throw new Error(`Could not create tickets: ${insertError.message}`);
  if (options.sendEmail !== false) {
    await sendBookingEmail(bookingId, customerEmail, customerName, voucherRemaining, labelledMeals);
    await markTicketsEmailed(bookingId);
  }
  return newTickets;
}

/**
 * Re-sign the QR codes of a booking's unused tickets and meal vouchers for a new
 * visit date. A QR code stops working after the visit date it was signed for, so
 * this must run whenever a booking's date changes. Ticket and voucher IDs stay
 * the same, so staff can still look them up by ID; scanned or cancelled ones are
 * left alone.
 */
export async function resignBookingQrCodes(bookingId: string, visitDate: string) {
  const [{ data: tickets, error: ticketsError }, { data: meals, error: mealsError }] = await Promise.all([
    supabase.from('tickets').select('id,ticket_uid').eq('booking_id', bookingId).eq('status', 'VALID'),
    supabase.from('meal_vouchers').select('id,meal_uid').eq('booking_id', bookingId).eq('status', 'VALID'),
  ]);
  if (ticketsError) throw ticketsError;
  if (mealsError) throw mealsError;
  for (const ticket of tickets || []) {
    const { error } = await supabase.from('tickets').update({ visit_date: visitDate, qr_token: createQrToken(bookingId, ticket.ticket_uid, visitDate) }).eq('id', ticket.id);
    if (error) throw error;
  }
  for (const meal of meals || []) {
    const { error } = await supabase.from('meal_vouchers').update({ visit_date: visitDate, qr_token: createQrToken(bookingId, meal.meal_uid, visitDate, 'meal') }).eq('id', meal.id);
    if (error) throw error;
  }
  return { tickets: tickets?.length || 0, meals: meals?.length || 0 };
}

/** Record that the tickets email went out (the booking status page and retries use this). */
async function markTicketsEmailed(bookingId: string) {
  const { error } = await supabase.rpc('finish_ticket_email', { p_booking_id: bookingId, p_sent: true });
  if (error) console.error(`Could not record the tickets email for booking ${bookingId}`, error);
}

/**
 * Email a booking's tickets exactly once, for automatic sends (payment
 * confirmed, proof approved, marked paid). The booking is claimed first, so two
 * PayFast notifications arriving together cannot both send the email.
 * Returns ALREADY_SENT / IN_PROGRESS without sending when someone else has.
 * Throws if sending fails; the claim is released so a retry can send.
 * Staff "Resend tickets" uses generateTicketsAndSendEmail directly instead.
 */
export async function emailTicketsOnce(bookingId: string, customerEmail: string, customerName: string): Promise<'SENT' | 'ALREADY_SENT' | 'IN_PROGRESS'> {
  const { data: claim, error: claimError } = await supabase.rpc('claim_ticket_email', { p_booking_id: bookingId });
  if (claimError) throw claimError;
  if (claim === 'ALREADY_SENT' || claim === 'IN_PROGRESS') return claim;
  if (claim !== 'CLAIMED') throw new Error(`Booking ${bookingId} not found`);
  try {
    await generateTicketsAndSendEmail(bookingId, customerEmail, customerName);
    return 'SENT';
  } catch (error) {
    const { error: releaseError } = await supabase.rpc('finish_ticket_email', { p_booking_id: bookingId, p_sent: false });
    if (releaseError) console.error(`Could not release the ticket email claim for booking ${bookingId}`, releaseError);
    throw error;
  }
}

function buildTicketDisplayNames(items: BookingItem[], seatingLabel = '') {
  const hutNames = items.flatMap(item => item.hut_id || item.metadata?.itemId?.startsWith('hut-')
    ? Array.from({ length: item.quantity }, () => item.huts?.name || item.metadata?.name || 'Hut')
    : []);
  const names: string[] = [];
  const attendeeFullNames: string[] = [];
  let assignedHuts = false;
  for (const item of items.filter(item => item.metadata?.isPerson === true || item.package_id)) {
    const itemAttendees = item.metadata?.attendeeNames || [];
    for (let i = 0; i < item.quantity; i++) {
      let name = item.packages?.name || item.metadata?.name || 'Entrance Ticket';
      if (hutNames.length && name.toLowerCase().includes('adult') && !assignedHuts) {
        name += ` + Includes: ${hutNames.join(', ')}`;
        assignedHuts = true;
      }
      if (seatingLabel) name += ` · Seating: ${seatingLabel}`;
      // Prepend attendee name if available
      const attendee = itemAttendees[i];
      if (attendee) {
        attendeeFullNames.push(`${attendee.firstName} ${attendee.lastName}`);
      } else {
        attendeeFullNames.push('');
      }
      names.push(name);
    }
  }
  return { names, attendeeFullNames };
}

/**
 * The booking email: one QR code for the whole booking (staff scan it once at
 * the gate and check the group in), a summary of the booking and a one-page
 * PDF. Meal vouchers keep their own QR codes for the kitchen. Paid bookings
 * get it when the payment is confirmed; staff can send it to any booking with
 * "Send booking QR", including unpaid ones (then it says what is still owed).
 */
async function sendBookingEmail(bookingId: string, email: string, name: string, voucherRemaining: number | null = null, meals: Array<Record<string, unknown>> = []) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  if (process.env.NODE_ENV === 'production' && !appUrl.startsWith('https://')) throw new Error('NEXT_PUBLIC_APP_URL must use HTTPS in production');
  if (!email) throw new Error('Customer email address is missing');

  const token = await ensureBookingQrToken(bookingId);
  const { data: row, error } = await supabase.from('bookings').select(BOOKING_CARD_SELECT).eq('id', bookingId).single();
  if (error) throw new Error(`Could not load the booking for its email: ${error.message}`);
  const card = buildBookingCard(row as unknown as BookingCardRow);
  const formattedVisitDate = formatVisitDate(card.visitDate);

  // QR codes are drawn here and embedded in the email as inline images (cid:),
  // so the codes are never sent to a third-party QR service and still show
  // when such a service is down. The same image goes into the PDF.
  const bookingQr = { contentId: 'booking-qr', filename: `${card.reference}-qr.png`, png: await QRCode.toBuffer(bookingScanUrl(appUrl, token), { type: 'png', width: 320, margin: 1 }) };
  const mealQrCodes = await Promise.all(meals.map(async (meal, index) => ({
    contentId: `meal-qr-${index + 1}`,
    filename: `${String(meal.meal_uid || `meal-${index + 1}`)}-qr.png`,
    png: await QRCode.toBuffer(mealScanUrl(appUrl, meal), { type: 'png', width: 220, margin: 1 }),
  })));

  const mealsHtml = meals.map((meal, index) => {
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #16a34a;border-radius:10px;margin-bottom:16px;overflow:hidden;">
      <tr>
        <td style="background:#16a34a;padding:8px 16px;">
          <p style="margin:0;color:#ffffff;font-size:11px;font-weight:700;letter-spacing:1px;">FREE MEAL VOUCHER ${index + 1} OF ${meals.length}</p>
        </td>
      </tr>
      <tr>
        <td style="padding:18px 20px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="vertical-align:top;">
                <p style="margin:0 0 10px;font-size:13px;font-weight:600;color:#334155;">${escapeHtml(String(meal.display_name || 'Free Meal'))}</p>
                <p style="margin:0;font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px;">Voucher ID</p>
                <p style="margin:0 0 12px;font-size:13px;font-family:'Courier New',monospace;color:#0f172a;">${escapeHtml(String(meal.meal_uid))}</p>
                <p style="margin:0;font-size:11px;color:#94a3b8;">Present this QR code to the kitchen staff.</p>
              </td>
              <td width="112" style="vertical-align:top;text-align:center;padding-left:14px;">
                <img src="cid:${mealQrCodes[index].contentId}" alt="QR Code for Meal" width="104" height="104" style="border:1px solid #16a34a;border-radius:8px;" />
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>`;
  }).join('');

  const { supportEmail, supportPhone } = await getBusinessSettings();
  const html = renderEmailLayout({
    supportEmail,
    supportPhone,
    preheader: `Your booking QR code for ${formattedVisitDate} is ready`,
    bodyHtml: bookingEmailBody({ card, customerName: name, qrContentId: bookingQr.contentId, voucherRemaining, mealsHtml, mealCount: meals.length }),
  });
  const bookingPdf = await createBookingPdf(card, bookingQr.png);
  const mealAttachments = await Promise.all(meals.map((meal, index) => createMealPdf(meal, mealQrCodes[index].png, index)));
  await sendEmail({
    to: email,
    subject: `Your booking for ${formattedVisitDate} - Graceland Venues`,
    html,
    replyTo: supportEmail,
    attachments: [
      { filename: bookingQr.filename, content: bookingQr.png, contentType: 'image/png', contentId: bookingQr.contentId },
      ...mealQrCodes.map(qr => ({ filename: qr.filename, content: qr.png, contentType: 'image/png', contentId: qr.contentId })),
      { filename: bookingPdf.filename, content: bookingPdf.content, contentType: 'application/pdf' },
      ...mealAttachments.map(({ filename, content }) => ({ filename, content, contentType: 'application/pdf' })),
    ],
  });
}

function mealScanUrl(appUrl: string, meal: Record<string, unknown>) {
  return `${appUrl}/admin/scanner?token=${encodeURIComponent(String(meal.qr_token))}`;
}

async function createMealPdf(meal: Record<string, unknown>, qrBuffer: Buffer, index: number) {
  const mealUid = String(meal.meal_uid || `meal-${index + 1}`);
  const displayName = String(meal.display_name || 'Free Meal');
  const rawVisitDate = String(meal.visit_date || '');
  const visitDate = rawVisitDate ? formatVisitDate(rawVisitDate) : 'See booking confirmation';

  const document = await PDFDocument.create();
  const page = document.addPage([595, 842]);
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const primary = rgb(22 / 255, 163 / 255, 74 / 255); // green-600
  const dark = rgb(15 / 255, 23 / 255, 42 / 255);
  const muted = rgb(100 / 255, 116 / 255, 139 / 255);

  const footerY = 80;
  page.drawText('This voucher is valid for one meal and may only be redeemed once.', { x: 125, y: footerY, size: 10, font: regular, color: muted });

  const scanInstructionY = 245;
  page.drawText('Present this QR code to the kitchen staff.', { x: 165, y: scanInstructionY, size: 13, font: regular, color: dark });

  const qrY = 275;
  const qrImage = await document.embedPng(qrBuffer);
  page.drawImage(qrImage, { x: 187, y: qrY, width: 220, height: 220 });

  const qrZoneTop = qrY + 220 + 15;

  page.drawRectangle({ x: 40, y: 42, width: 515, height: 758, borderColor: primary, borderWidth: 2 });
  page.drawText('GRACELAND VENUES', { x: 75, y: 720, size: 24, font: bold, color: primary });
  page.drawText('FREE MEAL VOUCHER', { x: 77, y: 690, size: 12, font: regular, color: muted });

  let nextY = 660;

  page.drawText(`Visit Date: ${visitDate}`, { x: 75, y: nextY, size: 16, font: bold, color: primary });
  nextY -= 30;

  const titleSize = 18;
  const titleLines = wrapPdfText(displayName, bold, 445, titleSize, 3);
  titleLines.forEach((line) => {
    if (nextY > qrZoneTop) {
      page.drawText(line, { x: 75, y: nextY, size: titleSize, font: bold, color: dark });
      nextY -= 23;
    }
  });

  nextY -= 10;
  if (nextY > qrZoneTop) {
    page.drawText(`Voucher ID: ${mealUid}`, { x: 75, y: nextY, size: 13, font: regular, color: muted });
  }

  const content = Buffer.from(await document.save());
  return { filename: `${mealUid}.pdf`, content };
}
