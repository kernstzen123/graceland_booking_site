/**
 * The booking email's content and PDF: one QR code for the whole booking and a
 * summary of what was booked (passes, hut or table, names, total and whether
 * it is paid). Free of database calls; src/lib/ticketing.ts loads the booking
 * and sends it.
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { BookingCard } from '@/lib/booking-card';
import { calloutBox, escapeHtml, statusBadge } from '@/lib/email-layout';

/** "2026-12-05" → "Saturday, 5 December 2026". */
export function formatVisitDate(dateStr: string): string {
  const parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  const date = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  if (isNaN(date.getTime())) return dateStr;
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${days[date.getDay()]}, ${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`;
}

const rands = (value: number) => `R ${value.toFixed(2)}`;
const peopleText = (people: number) => `${people} ${people === 1 ? 'person' : 'people'}`;

/** The summary lines shown in the email and the PDF. */
export function bookingSummaryLines(card: BookingCard) {
  return {
    passes: card.passes.map(pass => `${pass.quantity} × ${pass.name}`),
    seating: card.seating.length ? card.seating.join(', ') : 'No hut or table',
    payment: card.unpaid
      ? `NOT PAID${card.owing > 0 ? `: ${rands(card.owing)} still owed` : ''}${card.paid > 0 ? ` (${rands(card.paid)} paid)` : ''}`
      : card.owing > 0 ? `${rands(card.owing)} still owed` : 'Paid',
  };
}

/** The email body (inside the standard layout) for a booking's QR code email. */
export function bookingEmailBody(options: { card: BookingCard; customerName: string; qrContentId: string; voucherRemaining?: number | null; mealsHtml?: string; mealCount?: number }) {
  const { card } = options;
  const lines = bookingSummaryLines(card);
  const visitDate = formatVisitDate(card.visitDate);
  const row = (label: string, value: string, strong = false) => `<tr><td style="padding:6px 0;color:#64748b;font-size:13px;vertical-align:top;width:130px;">${escapeHtml(label)}</td><td style="padding:6px 0;font-size:14px;color:#0f172a;${strong ? 'font-weight:700;' : ''}">${value}</td></tr>`;
  const voucherNotice = options.voucherRemaining !== null && options.voucherRemaining !== undefined
    ? `<div style="background:#eff6ff;border:1px solid #93c5fd;padding:14px 16px;border-radius:8px;color:#1d4ed8;font-size:13px;margin-bottom:18px;"><strong>Voucher balance remaining:</strong> ${rands(options.voucherRemaining)}. Vouchers never expire and are valid for ticket purchases only.</div>`
    : '';
  const unpaidNotice = card.unpaid
    ? `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:12px 16px;margin:0 0 18px;"><p style="margin:0;color:#b91c1c;font-size:13px;"><strong>This booking is not paid yet.</strong> ${card.owing > 0 ? `${rands(card.owing)} is still owed. ` : ''}Please pay before your visit, using <strong>${escapeHtml(card.reference)}</strong> as the payment reference.</p></div>`
    : '';
  return `
    ${card.unpaid ? statusBadge('BOOKING RESERVED · NOT PAID', 'red') : statusBadge('BOOKING CONFIRMED', 'green')}
    <h1 style="margin:0 0 4px;font-size:20px;color:#0f172a;">Your booking QR code</h1>
    <p style="margin:0 0 18px;color:#64748b;font-size:13px;">Booking reference ${escapeHtml(card.reference)}</p>
    <p>Hi ${escapeHtml(options.customerName)},</p>
    <p>${card.unpaid ? 'Your booking is reserved.' : 'Your payment was successful and your booking is confirmed.'}</p>
    ${unpaidNotice}
    ${voucherNotice}
    ${calloutBox({ label: 'Visit Date', value: escapeHtml(visitDate + (card.partySlot ? ` · Party ${card.partySlot}` : '')), tone: 'green' })}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:2px solid #0EA5E9;border-radius:12px;margin:0 0 18px;">
      <tr><td style="padding:20px;text-align:center;">
        <p style="margin:0 0 12px;font-size:15px;font-weight:700;color:#0f172a;">Show this one QR code at the entrance for your whole group (${escapeHtml(peopleText(card.people))}).</p>
        <img src="cid:${options.qrContentId}" alt="Booking QR code" width="240" height="240" style="display:block;margin:0 auto;border:1px solid #e2e8f0;border-radius:8px;" />
        <p style="margin:12px 0 0;font-size:12px;color:#64748b;">Booking ${escapeHtml(card.reference)}. A PDF copy is attached: you can print it or show it on your phone.</p>
      </td></tr>
    </table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border-radius:10px;margin:0 0 18px;">
      <tr><td style="padding:14px 20px;">
        <p style="margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#64748b;">Your booking</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          ${row('Booking', escapeHtml(card.partySlot ? `Birthday party · ${card.partySlot}` : 'Day visit'))}
          ${row('Passes', lines.passes.map(escapeHtml).join('<br />') || '—')}
          ${row('Hut / table', escapeHtml(lines.seating))}
          ${card.names.length ? row('Names', card.names.map(escapeHtml).join(', ')) : ''}
          ${row('Total', escapeHtml(rands(card.total)), true)}
          ${row('Payment', `<span style="color:${card.unpaid || card.owing > 0 ? '#b91c1c' : '#15803d'};font-weight:700;">${escapeHtml(lines.payment)}</span>`)}
        </table>
      </td></tr>
    </table>
    ${options.mealsHtml ? `<p><strong>Free Meals:</strong> You also have ${options.mealCount || 0} free meal voucher(s). Each has its own QR code for the kitchen.</p>${options.mealsHtml}` : ''}
    <p>We look forward to seeing you!</p>
  `;
}

type PdfFont = Awaited<ReturnType<PDFDocument['embedFont']>>;

export function wrapPdfText(text: string, font: PdfFont, maxWidth: number, size: number, maxLines: number) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) { current = candidate; continue; }
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

/** One A4 page: the booking QR code with the booking's summary, to print or show on a phone. */
export async function createBookingPdf(card: BookingCard, qrPng: Buffer) {
  const document = await PDFDocument.create();
  const page = document.addPage([595, 842]);
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const primary = rgb(14 / 255, 165 / 255, 233 / 255);
  const dark = rgb(15 / 255, 23 / 255, 42 / 255);
  const muted = rgb(100 / 255, 116 / 255, 139 / 255);
  const green = rgb(21 / 255, 128 / 255, 61 / 255);
  const red = rgb(185 / 255, 28 / 255, 28 / 255);
  const lines = bookingSummaryLines(card);
  // The PDF font draws Western European characters only: anything else (e.g. emoji in a name) is left out of the PDF.
  const safe = (text: string) => text.replace(/[^\x20-\x7E -ÿ…–—‘’“”•€]/g, '');

  page.drawRectangle({ x: 40, y: 42, width: 515, height: 758, borderColor: primary, borderWidth: 2 });
  page.drawText('GRACELAND VENUES', { x: 75, y: 750, size: 24, font: bold, color: primary });
  page.drawText('BOOKING QR CODE', { x: 77, y: 728, size: 12, font: regular, color: muted });
  page.drawText(safe(`Visit Date: ${formatVisitDate(card.visitDate)}`), { x: 75, y: 700, size: 16, font: bold, color: green });
  let y = 676;
  for (const line of wrapPdfText(safe(card.customerName), bold, 445, 20, 1)) { page.drawText(line, { x: 75, y, size: 20, font: bold, color: dark }); y -= 22; }
  page.drawText(safe(`Booking ${card.reference} · ${card.partySlot ? `Birthday party ${card.partySlot}` : 'Day visit'} · ${peopleText(card.people)}`), { x: 75, y, size: 12, font: regular, color: muted });

  // QR code in the middle of the page.
  const qrImage = await document.embedPng(qrPng);
  page.drawImage(qrImage, { x: 177, y: 380, width: 240, height: 240 });
  page.drawText('Show this one QR code at the entrance for your whole group.', { x: 120, y: 360, size: 12, font: bold, color: dark });

  // Summary under the QR code.
  y = 330;
  const label = (text: string) => { page.drawText(text, { x: 75, y, size: 10, font: bold, color: muted }); };
  const value = (text: string, color = dark, font = regular) => {
    for (const line of wrapPdfText(safe(text), font, 330, 11, 2)) { if (y > 92) page.drawText(line, { x: 180, y, size: 11, font, color }); y -= 14; }
  };
  label('PASSES');
  const maxPasses = 9;
  for (const pass of lines.passes.slice(0, maxPasses)) value(pass);
  if (lines.passes.length > maxPasses) value(`… and ${lines.passes.length - maxPasses} more`);
  if (!lines.passes.length) value('—');
  y -= 4; label('HUT / TABLE'); value(lines.seating);
  y -= 4; label('TOTAL'); value(rands(card.total), dark, bold);
  y -= 4; label('PAYMENT'); value(lines.payment, card.unpaid || card.owing > 0 ? red : green, bold);
  page.drawText('Meal vouchers have their own QR codes for the kitchen.', { x: 155, y: 62, size: 9, font: regular, color: muted });

  return { filename: `${card.reference}.pdf`, content: Buffer.from(await document.save()) };
}
