import 'server-only';
import { supabase } from '@/lib/supabase';
import { escapeHtml, renderEmailLayout, calloutBox, statusBadge, buttonHtml } from '@/lib/email-layout';
import { BANK_DETAILS } from '@/lib/business-details';
import { getBusinessSettings } from '@/lib/business-settings';
import { customerHoldMessage, eftHoldHours, formatJohannesburgDateTime, holdBookingForPayment, isOpenEndedHold } from '@/lib/booking-holds';
import { sendEmail } from '@/lib/mailer';

/** A customer-safe reason the instructions were not sent (the booking is not payable). */
export class EftEmailRefused extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

/**
 * Hold the booking for EFT payment and email the bank details. Used when the
 * customer picks EFT, and when staff retry a failed email. The hold never goes
 * beyond EFT_HOLD_HOURS after the booking was made, and a lapsed booking is
 * only revived if the date, seating and voucher are still available.
 */
export async function sendEftInstructions(bookingId: string) {
  const { data: booking, error } = await supabase
    .from('bookings')
    .select('id, reference, status, total_amount, amount_due, visit_date, customers(first_name, email)')
    .eq('id', bookingId)
    .maybeSingle();
  if (error) throw error;
  if (!booking || !['UNPAID', 'PAYMENT_PENDING', 'PAYMENT_FAILED'].includes(booking.status)) {
    throw new EftEmailRefused('We could not send the payment instructions. Please check your booking reference and try again.');
  }
  const customer = Array.isArray(booking.customers) ? booking.customers[0] : booking.customers;
  const customerEmail = customer?.email || '';
  if (!customerEmail) throw new EftEmailRefused('We could not send the payment instructions. Please contact support.');
  const payableAmount = Number(booking.amount_due ?? booking.total_amount);
  if (!Number.isFinite(payableAmount) || payableAmount <= 0) throw new EftEmailRefused('This booking has no amount due');

  const hold = await holdBookingForPayment(booking.id, eftHoldHours() * 60);
  if (!hold.ok) throw new EftEmailRefused(customerHoldMessage(hold.reason, 'We could not send the payment instructions. Please contact support.'), 409);
  const holdNotice = booking.status !== 'PAYMENT_PENDING' && isOpenEndedHold(hold.holdUntil)
    ? 'Your booking is reserved for you. Please make the payment and upload your proof of payment before your visit.'
    : booking.status !== 'PAYMENT_PENDING' && hold.holdUntil
    ? `Your booking is held until <strong>${escapeHtml(formatJohannesburgDateTime(hold.holdUntil))}</strong> while we wait for proof of payment. If we have not received it by then, the booking will be released.`
    : 'We have already received a proof of payment for this booking.';

  const ref = booking.reference;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  if (process.env.NODE_ENV === 'production' && !appUrl.startsWith('https://')) throw new Error('NEXT_PUBLIC_APP_URL must use HTTPS in production');
  const uploadUrl = `${appUrl}/upload-proof?ref=${encodeURIComponent(ref)}`;
  const { supportEmail, supportPhone } = await getBusinessSettings();
  const bankRow = (label: string, value: string) => `<tr><td style="color:#64748b;">${label}</td><td style="text-align:right;font-weight:600;">${escapeHtml(value)}</td></tr>`;
  const html = renderEmailLayout({
    supportEmail,
    supportPhone,
    preheader: `Complete your EFT payment of R ${payableAmount.toFixed(2)} for booking ${ref}`,
    bodyHtml: `
      ${statusBadge('PAYMENT PENDING', 'amber')}
      <h1 style="margin:0 0 4px;font-size:20px;color:#0f172a;">Complete your EFT payment</h1>
      <p style="margin:0 0 18px;color:#64748b;font-size:13px;">Booking reference ${escapeHtml(ref)}</p>
      <p>Hi ${escapeHtml(customer?.first_name || 'there')},</p>
      <p>Thank you for booking with us. Please transfer the amount below to secure your booking for your visit on <strong>${escapeHtml(booking.visit_date || 'the date selected during booking')}</strong>.</p>
      ${calloutBox({ label: 'Amount to pay', value: `R ${escapeHtml(payableAmount.toFixed(2))}`, tone: 'amber' })}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border-radius:10px;margin:0 0 18px;">
        <tr><td style="padding:16px 20px;">
          <p style="margin:0 0 10px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#64748b;">Banking Details</p>
          <table role="presentation" width="100%" cellpadding="4" cellspacing="0" style="font-size:14px;color:#0f172a;">
            ${bankRow('Bank', BANK_DETAILS.bank)}
            ${bankRow('Account Name', BANK_DETAILS.accountName)}
            ${bankRow('Account Number', BANK_DETAILS.accountNumber)}
            ${bankRow('Branch Code', BANK_DETAILS.branchCode)}
          </table>
        </td></tr>
      </table>
      <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:12px 16px;margin:0 0 18px;">
        <p style="margin:0;color:#b91c1c;font-size:13px;"><strong>Important:</strong> Use <strong>${escapeHtml(ref)}</strong> as your payment reference so we can match your payment.</p>
      </div>
      <p>Once you have paid, upload your proof of payment so we can confirm your booking:</p>
      ${buttonHtml(uploadUrl, 'Upload Proof of Payment')}
      <p style="font-size:13px;color:#64748b;">${holdNotice} Tickets are issued once our team has reviewed and approved it.</p>
    `,
  });
  await sendEmail({ to: customerEmail, subject: `Payment Instructions for Booking ${ref}`, html, replyTo: supportEmail });
  return { customerEmail };
}
