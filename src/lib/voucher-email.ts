import nodemailer from 'nodemailer';
import { supabase } from './supabase';
import { escapeHtml, renderEmailLayout, calloutBox, statusBadge } from './email-layout';

export type VoucherEmail = {
  bookingReference: string;
  visitDate: string;
  customerEmail: string;
  customerName: string;
  creditCode: string;
  originalAmount: number;
};

export async function sendVoucherEmail(credit: VoucherEmail) {
  if (!credit.customerEmail) throw new Error('Customer email address is missing');
  const bookingUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  const supportEmail = process.env.NEXT_PUBLIC_SUPPORT_EMAIL || 'conny@gracelandvenues.co.za';
  const subject = 'Important update about your Graceland Venues booking';
  const html = renderEmailLayout({
    preheader: `Booking ${credit.bookingReference} was cancelled — a rebooking voucher is waiting for you`,
    supportEmail,
    bodyHtml: `
      ${statusBadge('BOOKING CANCELLED', 'red')}
      <h1 style="margin:0 0 4px;font-size:20px;color:#0f172a;">Important update about your booking</h1>
      <p style="margin:0 0 18px;color:#64748b;font-size:13px;">Booking reference ${escapeHtml(credit.bookingReference)}</p>
      <p>Hi ${escapeHtml(credit.customerName || 'there')},</p>
      <p>The waterpark is closed on <strong>${escapeHtml(credit.visitDate)}</strong>, so your booking has been cancelled.</p>
      <p>We do not process cash refunds. Instead, we have issued a rebooking voucher for the full amount paid: <strong>R ${credit.originalAmount.toFixed(2)}</strong>.</p>
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
  const fromEmail = process.env.NODE_ENV !== 'production' ? (process.env.SMTP_FROM_ADDRESS || process.env.SMTP_USER || 'bookings@gracelandvenues.co.za') : (process.env.EMAIL_FROM_ADDRESS || 'bookings@gracelandvenues.co.za');

  if (process.env.BREVO_API_KEY) {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', { method: 'POST', headers: { accept: 'application/json', 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ sender: { email: fromEmail, name: 'Graceland Venues' }, to: [{ email: credit.customerEmail, name: credit.customerName }], subject, htmlContent: html }) });
    if (!response.ok) throw new Error('Brevo rejected the voucher email');
    return;
  }
  if (process.env.NODE_ENV !== 'production') {
    const host = process.env.SMTP_HOST; const user = process.env.SMTP_USER; const pass = process.env.SMTP_PASS;
    if (!host || !user || !pass) throw new Error('SMTP is not configured');
    const port = Number(process.env.SMTP_PORT || 587);
    await nodemailer.createTransport({ host, port, secure: process.env.SMTP_SECURE === 'true' || port === 465, auth: { user, pass } }).sendMail({ from: `Graceland Venues <${fromEmail}>`, to: credit.customerEmail, subject, html });
    return;
  }
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) throw new Error('Email provider is not configured');
  const response = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: `Graceland Venues <${fromEmail}>`, to: [credit.customerEmail], subject, html }) });
  if (!response.ok) throw new Error('Resend rejected the voucher email');
}

export async function recordNotificationFailure(entityType: string, type: string, recipient: string, entityId: string, error: unknown) {
  const { error: insertError } = await supabase.from('notification_failures').insert({ notification_type: type, recipient, entity_type: entityType, entity_id: entityId, error_message: error instanceof Error ? error.message : 'Unknown email error' });
  if (insertError) console.error('Could not record notification failure', insertError);
}
