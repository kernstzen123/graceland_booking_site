import 'server-only';
import crypto from 'crypto';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import QRCode from 'qrcode';
import { supabase } from './supabase';
import { createQrToken } from './qr-token';
import { escapeHtml, renderEmailLayout, calloutBox, statusBadge } from './email-layout';
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
  bookings?: { visit_date?: string; customer_id?: string; voucher_credit_id?: string | null } | null;
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
    .select('*, bookings(visit_date, customer_id, voucher_credit_id), packages(name), huts(name)')
    .eq('booking_id', bookingId);
  if (itemsError) throw new Error(`Could not load booking items: ${itemsError.message}`);

  const items = (bookingItems || []) as BookingItem[];
  const { data: bookingSpots, error: spotsError } = await supabase
    .from('booking_spots')
    .select('venue_spots(number,type)')
    .eq('booking_id', bookingId);
  if (spotsError) throw new Error(`Could not load booking seating: ${spotsError.message}`);

  const { data: existingMeals } = await supabase.from('meal_vouchers').select('meal_uid, qr_token, visit_date, specials(title)').eq('booking_id', bookingId);
  const { data: bookingSpecials } = await supabase.from('booking_specials').select('special_id, quantity, snapshot').eq('booking_id', bookingId);
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

  // ITNs can be retried after ticket creation. Reuse those tickets so a
  // failed email delivery can be retried without issuing duplicate tickets.
  let labelledMeals: Array<Record<string, unknown>> = [];
  if (existingMeals?.length) {
    labelledMeals = existingMeals.map(m => ({
      ...m,
      display_name: `${mealName} (${(m.specials as any)?.title || 'Special'})`,
    }));
  }

  if (existingTickets?.length) {
    const labelledTickets = existingTickets.map((ticket, index) => ({
      ...ticket,
      display_name: displayNames[index] || 'Entrance Ticket',
      attendee_name: attendeeFullNames[index] || '',
    }));
    if (options.sendEmail !== false) {
      await sendTicketsEmail(customerEmail, customerName, labelledTickets as Array<Record<string, unknown>>, voucherRemaining, labelledMeals);
      await markTicketsEmailed(bookingId);
    }
    return labelledTickets;
  }

  const newTickets: Array<Record<string, unknown>> = [];
  const newMeals: Array<Record<string, unknown>> = [];
  if (!existingMeals?.length && bookingSpecials?.length) {
    for (const bs of bookingSpecials) {
      const mealDefinitions = bs.snapshot.included_meals?.length 
        ? bs.snapshot.included_meals 
        : (bs.snapshot.free_meals > 0 ? [{ name: mealName, quantity: bs.snapshot.free_meals }] : []);
        
      for (const mDef of mealDefinitions) {
        const totalMeals = mDef.quantity * bs.quantity;
        for (let i = 0; i < totalMeals; i++) {
          const mealUid = `MEAL-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
          const qrToken = createQrToken(bookingId, mealUid, String(items[0]?.bookings?.visit_date), 'meal');
          newMeals.push({
            booking_id: bookingId,
            special_id: bs.special_id,
            meal_uid: mealUid,
            qr_token: qrToken,
            visit_date: items[0]?.bookings?.visit_date,
            meal_name: mDef.name,
            display_name: `${mDef.name} (${bs.snapshot.title})`
          });
        }
      }
    }
    labelledMeals = newMeals;
  }
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
  if (newMeals.length > 0) {
    const { error: insertMealsError } = await supabase.from('meal_vouchers').insert(newMeals.map(m => ({
      booking_id: m.booking_id, special_id: m.special_id, meal_uid: m.meal_uid, qr_token: m.qr_token, visit_date: m.visit_date, meal_name: m.meal_name
    })));
    if (insertMealsError) throw new Error(`Could not create meal vouchers: ${insertMealsError.message}`);
  }
  if (options.sendEmail !== false) {
    await sendTicketsEmail(customerEmail, customerName, newTickets, voucherRemaining, labelledMeals);
    await markTicketsEmailed(bookingId);
  }
  return newTickets;
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

async function sendTicketsEmail(email: string, name: string, tickets: Array<Record<string, unknown>>, voucherRemaining: number | null = null, meals: Array<Record<string, unknown>> = []) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  if (process.env.NODE_ENV === 'production' && !appUrl.startsWith('https://')) throw new Error('NEXT_PUBLIC_APP_URL must use HTTPS in production');
  if (!email) throw new Error('Customer email address is missing');

  // Extract the visit date from the first ticket for the email header
  const rawVisitDate = String(tickets[0]?.visit_date || '');
  const formattedVisitDate = rawVisitDate ? formatVisitDate(rawVisitDate) : '';

  // QR codes are drawn here and embedded in the email as inline images (cid:),
  // so ticket tokens are never sent to a third-party QR service and the codes
  // still show when such a service is down. The same images go into the PDFs.
  const qrCodes = await Promise.all(tickets.map(async (ticket, index) => ({
    contentId: `ticket-qr-${index + 1}`,
    filename: `${String(ticket.ticket_uid || `ticket-${index + 1}`)}-qr.png`,
    png: await QRCode.toBuffer(ticketScanUrl(appUrl, ticket), { type: 'png', width: 220, margin: 1 }),
  })));

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

  const ticketsHtml = tickets.map((ticket, index) => {
    const attendeeName = String(ticket.attendee_name || '');
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:10px;margin-bottom:16px;overflow:hidden;">
      <tr>
        <td style="background:#0EA5E9;padding:8px 16px;">
          <p style="margin:0;color:#ffffff;font-size:11px;font-weight:700;letter-spacing:1px;">TICKET ${index + 1} OF ${tickets.length}</p>
        </td>
      </tr>
      <tr>
        <td style="padding:18px 20px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="vertical-align:top;">
                ${attendeeName ? `<p style="margin:0 0 4px;font-size:16px;font-weight:700;color:#0f172a;">${escapeHtml(attendeeName)}</p>` : ''}
                <p style="margin:0 0 10px;font-size:13px;font-weight:600;color:#334155;">${escapeHtml(String(ticket.display_name || 'Entrance Ticket'))}</p>
                <p style="margin:0;font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px;">Ticket ID</p>
                <p style="margin:0 0 12px;font-size:13px;font-family:'Courier New',monospace;color:#0f172a;">${escapeHtml(String(ticket.ticket_uid))}</p>
                <p style="margin:0;font-size:11px;color:#94a3b8;">Present this QR code at the entrance scanner.</p>
              </td>
              <td width="112" style="vertical-align:top;text-align:center;padding-left:14px;">
                <img src="cid:${qrCodes[index].contentId}" alt="QR Code for Ticket" width="104" height="104" style="border:1px solid #e2e8f0;border-radius:8px;" />
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>`;
  }).join('');
  const voucherNotice = voucherRemaining !== null ? `<div style="background:#eff6ff;border:1px solid #93c5fd;padding:14px 16px;border-radius:8px;color:#1d4ed8;font-size:13px;margin-bottom:18px;"><strong>Voucher balance remaining:</strong> R ${voucherRemaining.toFixed(2)}. Vouchers never expire and are valid for ticket purchases only.</div>` : '';
  const visitDateBanner = formattedVisitDate ? calloutBox({ label: 'Visit Date', value: escapeHtml(formattedVisitDate), tone: 'green' }) : '';
  const { supportEmail, supportPhone } = await getBusinessSettings();
  const html = renderEmailLayout({
    supportEmail,
    supportPhone,
    preheader: formattedVisitDate ? `Your tickets for ${formattedVisitDate} are ready` : 'Your Graceland Venues tickets are ready',
    bodyHtml: `
      ${statusBadge('BOOKING CONFIRMED', 'green')}
      <h1 style="margin:0 0 16px;font-size:20px;color:#0f172a;">Your tickets are ready</h1>
      <p>Hi ${escapeHtml(name)},</p>
      <p>Your payment was successful and your booking is confirmed.</p>
      ${voucherNotice}
      ${visitDateBanner}
      <p>Each person requires their own ticket to enter${tickets.length > 1 ? ` — you have <strong>${tickets.length} tickets</strong> below` : ''}. A PDF copy of every ticket is also attached to this email.</p>
      ${ticketsHtml}
      ${mealsHtml.length > 0 ? `<p><strong>Free Meals:</strong> You also have ${meals.length} free meal voucher(s) included.</p>${mealsHtml}` : ''}
      <p>We look forward to seeing you!</p>
    `,
  });
  const attachments = await Promise.all(tickets.map((ticket, index) => createTicketPdf(ticket, qrCodes[index].png, index)));
  const mealAttachments = await Promise.all(meals.map((meal, index) => createMealPdf(meal, mealQrCodes[index].png, index)));
  await sendEmail({
    to: email,
    subject: formattedVisitDate ? `Your Tickets for ${formattedVisitDate} - Graceland Venues` : 'Your Tickets - Graceland Venues',
    html,
    replyTo: supportEmail,
    attachments: [
      ...qrCodes.map(qr => ({ filename: qr.filename, content: qr.png, contentType: 'image/png', contentId: qr.contentId })),
      ...mealQrCodes.map(qr => ({ filename: qr.filename, content: qr.png, contentType: 'image/png', contentId: qr.contentId })),
      ...attachments.map(({ filename, content }) => ({ filename, content, contentType: 'application/pdf' })),
      ...mealAttachments.map(({ filename, content }) => ({ filename, content, contentType: 'application/pdf' })),
    ],
  });
}

/** What a ticket's QR code encodes: the staff scanner link with the signed ticket token. */
function ticketScanUrl(appUrl: string, ticket: Record<string, unknown>) {
  return `${appUrl}/admin/scanner?token=${encodeURIComponent(String(ticket.qr_token))}`;
}

async function createTicketPdf(ticket: Record<string, unknown>, qrBuffer: Buffer, index: number) {
  const ticketUid = String(ticket.ticket_uid || `ticket-${index + 1}`);
  const displayName = String(ticket.display_name || 'Entrance Ticket');
  const attendeeName = String(ticket.attendee_name || '');
  const rawVisitDate = String(ticket.visit_date || '');
  const visitDate = rawVisitDate ? formatVisitDate(rawVisitDate) : 'See booking confirmation';

  const document = await PDFDocument.create();
  const page = document.addPage([595, 842]);
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const primary = rgb(14 / 255, 165 / 255, 233 / 255);
  const dark = rgb(15 / 255, 23 / 255, 42 / 255);
  const muted = rgb(100 / 255, 116 / 255, 139 / 255);
  const green = rgb(21 / 255, 128 / 255, 61 / 255);

  // --- Fixed bottom-up layout for QR code and footer ---
  // This ensures these elements never collide with the top-down text.
  const footerY = 80;
  page.drawText('This ticket is valid for one person and may only be used once.', { x: 115, y: footerY, size: 10, font: regular, color: muted });

  const scanInstructionY = 245;
  page.drawText('Present this QR code at the entrance scanner.', { x: 145, y: scanInstructionY, size: 13, font: regular, color: dark });

  const qrY = 275;
  const qrImage = await document.embedPng(qrBuffer);
  page.drawImage(qrImage, { x: 187, y: qrY, width: 220, height: 220 });

  // --- Top-down layout for ticket info ---
  // The QR zone starts at qrY + 220 = 495, so text must stay above that.
  const qrZoneTop = qrY + 220 + 15; // 510 — safe boundary

  page.drawRectangle({ x: 40, y: 42, width: 515, height: 758, borderColor: primary, borderWidth: 2 });
  page.drawText('GRACELAND VENUES', { x: 75, y: 720, size: 24, font: bold, color: primary });
  page.drawText('DIGITAL ENTRY TICKET', { x: 77, y: 690, size: 12, font: regular, color: muted });

  let nextY = 660;

  // Visit date — displayed prominently at the top so it's never hidden
  page.drawText(`Visit Date: ${visitDate}`, { x: 75, y: nextY, size: 16, font: bold, color: green });
  nextY -= 30;

  // Attendee name (prominent, if available)
  if (attendeeName) {
    const nameLines = wrapPdfText(attendeeName, bold, 445, 22, 2);
    nameLines.forEach((line) => {
      if (nextY > qrZoneTop) {
        page.drawText(line, { x: 75, y: nextY, size: 22, font: bold, color: dark });
        nextY -= 28;
      }
    });
    nextY -= 4;
  }

  // Ticket type / display name
  const titleSize = 18;
  const titleLines = wrapPdfText(displayName, bold, 445, titleSize, 3);
  titleLines.forEach((line) => {
    if (nextY > qrZoneTop) {
      page.drawText(line, { x: 75, y: nextY, size: titleSize, font: bold, color: primary });
      nextY -= 23;
    }
  });

  nextY -= 10;
  if (nextY > qrZoneTop) {
    page.drawText(`Ticket ID: ${ticketUid}`, { x: 75, y: nextY, size: 13, font: regular, color: muted });
  }

  const content = Buffer.from(await document.save());

  return { filename: `${ticketUid}.pdf`, content };
}

function formatVisitDate(dateStr: string): string {
  // Parse as local date (avoid timezone shift by splitting manually)
  const parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  const date = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  if (isNaN(date.getTime())) return dateStr;
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${days[date.getDay()]}, ${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`;
}

function wrapPdfText(text: string, font: Awaited<ReturnType<PDFDocument['embedFont']>>, maxWidth: number, size: number, maxLines: number) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    current = word;
  }
  if (current) lines.push(current);

  if (lines.length <= maxLines) return lines;
  const visible = lines.slice(0, maxLines);
  let last = visible[maxLines - 1];
  while (last.length > 1 && font.widthOfTextAtSize(`${last}…`, size) > maxWidth) last = last.slice(0, -1);
  visible[maxLines - 1] = `${last}…`;
  return visible;
}

function mealScanUrl(appUrl: string, meal: Record<string, unknown>) {
  return `${appUrl}/admin/meals?token=${encodeURIComponent(String(meal.qr_token))}`;
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
