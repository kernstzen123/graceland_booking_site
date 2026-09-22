import crypto from 'crypto';
import nodemailer from 'nodemailer';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import QRCode from 'qrcode';
import { supabase } from './supabase';
import { createQrToken } from './qr-token';
import { escapeHtml, renderEmailLayout, calloutBox, statusBadge } from './email-layout';

type BookingItem = {
  quantity: number;
  package_id: string | null;
  hut_id: string | null;
  metadata: { name?: string; itemId?: string; isPerson?: boolean; attendeeNames?: Array<{ firstName: string; lastName: string }> } | null;
  packages?: { name?: string } | null;
  huts?: { name?: string } | null;
  bookings?: { visit_date?: string; customer_id?: string; voucher_credit_id?: string | null } | null;
};

export async function generateTicketsAndSendEmail(bookingId: string, customerEmail: string, customerName: string) {
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

  const seatingLabel = (bookingSpots || []).map((row) => {
    const spot = Array.isArray(row.venue_spots) ? row.venue_spots[0] : row.venue_spots;
    if (!spot?.number) return null;
    return `${spot.type === 'table' ? 'Table' : 'Hut'} ${spot.number}`;
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
  if (existingTickets?.length) {
    const labelledTickets = existingTickets.map((ticket, index) => ({
      ...ticket,
      display_name: displayNames[index] || 'Entrance Ticket',
      attendee_name: attendeeFullNames[index] || '',
    }));
    await sendTicketsEmail(customerEmail, customerName, labelledTickets as Array<Record<string, unknown>>, voucherRemaining);
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
  await sendTicketsEmail(customerEmail, customerName, newTickets, voucherRemaining);
  return newTickets;
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

async function sendTicketsEmail(email: string, name: string, tickets: Array<Record<string, unknown>>, voucherRemaining: number | null = null) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  if (process.env.NODE_ENV === 'production' && !appUrl.startsWith('https://')) throw new Error('NEXT_PUBLIC_APP_URL must use HTTPS in production');
  if (!email) throw new Error('Customer email address is missing');

  // Extract the visit date from the first ticket for the email header
  const rawVisitDate = String(tickets[0]?.visit_date || '');
  const formattedVisitDate = rawVisitDate ? formatVisitDate(rawVisitDate) : '';

  const ticketsHtml = tickets.map((ticket, index) => {
    const scanUrl = `${appUrl}/admin/scanner?token=${encodeURIComponent(String(ticket.qr_token))}`;
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(scanUrl)}`;
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
                <img src="${qrUrl}" alt="QR Code for Ticket" width="104" height="104" style="border:1px solid #e2e8f0;border-radius:8px;" />
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>`;
  }).join('');
  const voucherNotice = voucherRemaining !== null ? `<div style="background:#eff6ff;border:1px solid #93c5fd;padding:14px 16px;border-radius:8px;color:#1d4ed8;font-size:13px;margin-bottom:18px;"><strong>Voucher balance remaining:</strong> R ${voucherRemaining.toFixed(2)}. Vouchers never expire and are valid for ticket purchases only.</div>` : '';
  const visitDateBanner = formattedVisitDate ? calloutBox({ label: 'Visit Date', value: `📅 ${escapeHtml(formattedVisitDate)}`, tone: 'green' }) : '';
  const html = renderEmailLayout({
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
      <p>We look forward to seeing you!</p>
    `,
  });
  const attachments = await Promise.all(tickets.map((ticket, index) => createTicketPdf(ticket, appUrl, index)));
  const fromEmail = process.env.NODE_ENV !== 'production'
    ? (process.env.SMTP_FROM_ADDRESS || process.env.SMTP_USER || 'bookings@gracelandvenues.co.za')
    : (process.env.EMAIL_FROM_ADDRESS || 'bookings@gracelandvenues.co.za');

  const resendApiKey = process.env.RESEND_API_KEY;
  if (resendApiKey && resendApiKey !== 'your-resend-api-key') {
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST', headers: { Authorization: `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: `Graceland Venues <${fromEmail}>`,
          to: [email],
          subject: formattedVisitDate ? `Your Tickets for ${formattedVisitDate} - Graceland Venues` : 'Your Tickets - Graceland Venues',
          html,
          attachments: attachments.map(({ filename, content }) => ({
            filename,
            content: content.toString('base64'),
          })),
        }),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => 'unknown error');
        throw new Error(`Failed to send ticket email via Resend: ${body}`);
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('Failed to send ticket email via Resend:')) throw e;
      throw new Error(`Resend email delivery failed: ${e instanceof Error ? e.message : 'unknown error'}`);
    }
    return;
  }

  const smtpHost = process.env.SMTP_HOST;
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  if (!smtpHost || !smtpUser || !smtpPass) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('No email provider configured (neither RESEND_API_KEY nor SMTP). Cannot deliver tickets.');
    }
    console.error('Neither RESEND_API_KEY nor SMTP credentials are configured. Skipping email delivery.');
    return;
  }

  const smtpPort = Number(process.env.SMTP_PORT || 587);
  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: process.env.SMTP_SECURE === 'true' || smtpPort === 465,
    auth: { user: smtpUser, pass: smtpPass },
  });
  await transporter.sendMail({
    from: `Graceland Venues <${fromEmail}>`,
    to: email,
    subject: formattedVisitDate ? `Your Tickets for ${formattedVisitDate} - Graceland Venues` : 'Your Tickets - Graceland Venues',
    html,
    attachments: attachments.map(({ filename, content }) => ({ filename, content })),
  });
}

async function createTicketPdf(ticket: Record<string, unknown>, appUrl: string, index: number) {
  const ticketUid = String(ticket.ticket_uid || `ticket-${index + 1}`);
  const displayName = String(ticket.display_name || 'Entrance Ticket');
  const attendeeName = String(ticket.attendee_name || '');
  const rawVisitDate = String(ticket.visit_date || '');
  const visitDate = rawVisitDate ? formatVisitDate(rawVisitDate) : 'See booking confirmation';
  const scanUrl = `${appUrl}/admin/scanner?token=${encodeURIComponent(String(ticket.qr_token))}`;
  const qrBuffer = await QRCode.toBuffer(scanUrl, { type: 'png', width: 220, margin: 1 });

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
