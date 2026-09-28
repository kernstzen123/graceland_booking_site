import 'server-only';
import { escapeHtml, renderEmailLayout, calloutBox, statusBadge } from './email-layout';
import { getBusinessSettings } from './business-settings';
import { sendEmail } from './mailer';

// Kept here so existing imports keep working; the implementation lives in mailer.ts.
export { recordNotificationFailure } from './mailer';

export type VoucherEmail = {
  bookingReference: string;
  visitDate: string;
  customerEmail: string;
  customerName: string;
  creditCode: string;
  /** The voucher value. */
  originalAmount: number;
  /** What the customer paid, before any cancellation fee. Defaults to the voucher value. */
  paidAmount?: number | null;
  deductionPercentage?: number | null;
  /** 'closure': Graceland closed the date ("refund all for date"). Otherwise the booking was cancelled individually. */
  reason?: 'closure' | 'cancellation' | string | null;
};

export async function sendVoucherEmail(credit: VoucherEmail) {
  if (!credit.customerEmail) throw new Error('Customer email address is missing');
  const bookingUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  const { supportEmail, supportPhone } = await getBusinessSettings();
  const subject = 'Important update about your Graceland Venues booking';
  const fee = Number(credit.deductionPercentage || 0);
  const paid = Number(credit.paidAmount ?? credit.originalAmount);
  const cancellationText = credit.reason === 'closure'
    ? `The waterpark is closed on <strong>${escapeHtml(credit.visitDate)}</strong>, so your booking has been cancelled.`
    : `Your booking for <strong>${escapeHtml(credit.visitDate)}</strong> has been cancelled.`;
  const amountText = fee > 0
    ? `We do not process cash refunds. Instead, we have issued a rebooking voucher for <strong>R ${credit.originalAmount.toFixed(2)}</strong>: the R ${paid.toFixed(2)} you paid, less the ${escapeHtml(String(fee))}% cancellation fee.`
    : `We do not process cash refunds. Instead, we have issued a rebooking voucher for the full amount paid: <strong>R ${credit.originalAmount.toFixed(2)}</strong>.`;
  const html = renderEmailLayout({
    preheader: `Booking ${credit.bookingReference} was cancelled — a rebooking voucher is waiting for you`,
    supportEmail,
    supportPhone,
    bodyHtml: `
      ${statusBadge('BOOKING CANCELLED', 'red')}
      <h1 style="margin:0 0 4px;font-size:20px;color:#0f172a;">Important update about your booking</h1>
      <p style="margin:0 0 18px;color:#64748b;font-size:13px;">Booking reference ${escapeHtml(credit.bookingReference)}</p>
      <p>Hi ${escapeHtml(credit.customerName || 'there')},</p>
      <p>${cancellationText}</p>
      <p>${amountText}</p>
      ${calloutBox({ label: 'Your voucher code', value: escapeHtml(credit.creditCode), tone: 'blue' })}
      <p style="font-size:13px;color:#475569;background:#f8fafc;border-radius:8px;padding:14px 16px;margin:0 0 18px;">This voucher never expires and may be used across multiple future bookings until the balance is depleted. It is valid for ticket purchases only and cannot be used at the kiosk for food, drinks, or merchandise.</p>
      <p style="margin:0 0 8px;font-weight:700;color:#0f172a;font-size:14px;">How to use it</p>
      <ol style="margin:0 0 18px;padding-left:18px;color:#334155;">
        <li style="margin-bottom:6px;">Visit <a href="${escapeHtml(bookingUrl)}" style="color:#0EA5E9;">${escapeHtml(bookingUrl)}</a> and choose a new date.</li>
        <li style="margin-bottom:6px;">Enter your voucher code at checkout.</li>
        <li>If your new booking costs more than the remaining voucher balance, pay the difference by EFT as usual.</li>
      </ol>
      <p>We apologise for the inconvenience.</p>
    `,
  });
  await sendEmail({ to: credit.customerEmail, subject, html, replyTo: supportEmail });
}
