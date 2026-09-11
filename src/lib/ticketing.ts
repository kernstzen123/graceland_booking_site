import crypto from 'crypto';
import nodemailer from 'nodemailer';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import QRCode from 'qrcode';
import { supabase } from './supabase';
import { createQrToken } from './qr-token';

type BookingItem = {
  quantity: number;
  package_id: string | null;
  hut_id: string | null;
  metadata: { name?: string; itemId?: string; isPerson?: boolean } | null;
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
  const displayNames = buildTicketDisplayNames(items, seatingLabel);
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
      const displayName = displayNames[personIndex++] || 'Entrance Ticket';
      newTickets.push({
        booking_id: bookingId, package_id: item.package_id, customer_id: item.bookings?.customer_id,
        ticket_uid: ticketUid, qr_token: qrToken, visit_date: item.bookings?.visit_date,
        display_name: displayName,
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
  let assignedHuts = false;
  for (const item of items.filter(item => item.metadata?.isPerson === true || item.package_id)) {
    for (let i = 0; i < item.quantity; i++) {
      let name = item.packages?.name || item.metadata?.name || 'Entrance Ticket';
      if (hutNames.length && name.toLowerCase().includes('adult') && !assignedHuts) {
        name += ` + Includes: ${hutNames.join(', ')}`;
        assignedHuts = true;
      }
      if (seatingLabel) name += ` · Seating: ${seatingLabel}`;
      names.push(name);
    }
  }
  return names;
}

async function sendTicketsEmail(email: string, name: string, tickets: Array<Record<string, unknown>>, voucherRemaining: number | null = null) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  if (process.env.NODE_ENV === 'production' && !appUrl.startsWith('https://')) throw new Error('NEXT_PUBLIC_APP_URL must use HTTPS in production');
  if (!email) throw new Error('Customer email address is missing');

  const escapeHtml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
  const ticketsHtml = tickets.map((ticket, index) => {
    const scanUrl = `${appUrl}/admin/scanner?token=${encodeURIComponent(String(ticket.qr_token))}`;
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(scanUrl)}`;
    return `<div style="border:2px solid #0EA5E9;border-radius:8px;padding:20px;margin-bottom:20px;text-align:center;background:#f8fafc">
      <h3 style="color:#0EA5E9">TICKET ${index + 1}</h3>
      <p style="font-size:1.2rem;font-weight:bold;color:#0f172a">${escapeHtml(String(ticket.display_name || 'Entrance Ticket'))}</p>
      <p style="color:#64748b"><strong>Ticket ID:</strong> ${escapeHtml(String(ticket.ticket_uid))}</p>
      <img src="${qrUrl}" alt="QR Code for Ticket" width="200" height="200" />
      <p style="color:#64748b">Present this QR code at the entrance scanner.</p>
    </div>`;
  }).join('');
  const voucherNotice = voucherRemaining !== null ? `<p style="background:#eff6ff;border:1px solid #93c5fd;padding:12px;border-radius:6px;color:#1d4ed8"><strong>Voucher balance remaining:</strong> R ${voucherRemaining.toFixed(2)}. Vouchers never expire and are valid for ticket purchases only.</p>` : '';
  const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#0f172a">
    <h2 style="color:#0EA5E9">Your Graceland Venues Tickets</h2><p>Hi ${escapeHtml(name)},</p>${voucherNotice}
    <p>Your payment was successful and your booking is confirmed.</p>
    <p>Each person requires their own ticket to enter.</p>${ticketsHtml}<p>We look forward to seeing you!</p>
  </div>`;
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
          subject: 'Your Tickets - Graceland Venues',
          html,
          attachments: attachments.map(({ filename, content }) => ({
            filename,
            content: content.toString('base64'),
          })),
        }),
      });
      if (!response.ok) {
        console.error(`Failed to send ticket email via Resend: ${await response.text()}`);
      }
    } catch (e) {
      console.error('Resend email delivery failed, but payment was successful:', e);
    }
    return;
  }

  const smtpHost = process.env.SMTP_HOST;
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  if (!smtpHost || !smtpUser || !smtpPass) {
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
  try {
    await transporter.sendMail({
      from: `Graceland Venues <${fromEmail}>`,
      to: email,
      subject: 'Your Tickets - Graceland Venues',
      html,
      attachments: attachments.map(({ filename, content }) => ({ filename, content })),
    });
  } catch (e) {
    console.error('SMTP email delivery failed, but payment was successful:', e);
  }
}

async function createTicketPdf(ticket: Record<string, unknown>, appUrl: string, index: number) {
  const ticketUid = String(ticket.ticket_uid || `ticket-${index + 1}`);
  const displayName = String(ticket.display_name || 'Entrance Ticket');
  const visitDate = String(ticket.visit_date || 'See booking confirmation');
  const scanUrl = `${appUrl}/admin/scanner?token=${encodeURIComponent(String(ticket.qr_token))}`;
  const qrBuffer = await QRCode.toBuffer(scanUrl, { type: 'png', width: 220, margin: 1 });

  const document = await PDFDocument.create();
  const page = document.addPage([595, 842]);
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const primary = rgb(14 / 255, 165 / 255, 233 / 255);
  const dark = rgb(15 / 255, 23 / 255, 42 / 255);
  const muted = rgb(100 / 255, 116 / 255, 139 / 255);

  page.drawRectangle({ x: 40, y: 42, width: 515, height: 758, borderColor: primary, borderWidth: 2 });
  page.drawText('GRACELAND VENUES', { x: 75, y: 720, size: 24, font: bold, color: primary });
  page.drawText('DIGITAL ENTRY TICKET', { x: 77, y: 690, size: 12, font: regular, color: muted });
  const titleSize = 20;
  const titleLines = wrapPdfText(displayName, bold, 445, titleSize, 3);
  titleLines.forEach((line, lineIndex) => {
    page.drawText(line, { x: 75, y: 640 - lineIndex * 25, size: titleSize, font: bold, color: dark });
  });
  const detailsY = 640 - titleLines.length * 25 - 14;
  page.drawText(`Ticket ID: ${ticketUid}`, { x: 75, y: detailsY, size: 13, font: regular, color: muted });
  page.drawText(`Visit date: ${visitDate}`, { x: 75, y: detailsY - 22, size: 13, font: regular, color: muted });
  const qrImage = await document.embedPng(qrBuffer);
  page.drawImage(qrImage, { x: 187, y: 335, width: 220, height: 220 });
  page.drawText('Present this QR code at the entrance scanner.', { x: 145, y: 280, size: 13, font: regular, color: dark });
  page.drawText('This ticket is valid for one person and may only be used once.', { x: 115, y: 115, size: 10, font: regular, color: muted });

  const content = Buffer.from(await document.save());

  return { filename: `${ticketUid}.pdf`, content };
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
