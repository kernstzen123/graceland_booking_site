import nodemailer from 'nodemailer';
import { supabase } from './supabase';

export type VoucherEmail = {
  bookingReference: string;
  visitDate: string;
  customerEmail: string;
  customerName: string;
  creditCode: string;
  originalAmount: number;
};

const escapeHtml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');

export async function sendVoucherEmail(credit: VoucherEmail) {
  if (!credit.customerEmail) throw new Error('Customer email address is missing');
  const bookingUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  const supportEmail = process.env.NEXT_PUBLIC_SUPPORT_EMAIL || 'conny@gracelandvenues.co.za';
  const subject = 'Important update about your Graceland Venues booking';
  const html = `<div style="font-family:Arial,sans-serif;max-width:620px;margin:auto;color:#0f172a"><h2 style="color:#0EA5E9">Important update about your Graceland Venues booking</h2><p>Hi ${escapeHtml(credit.customerName || 'there')},</p><p>The waterpark is closed on <strong>${escapeHtml(credit.visitDate)}</strong>, so booking <strong>${escapeHtml(credit.bookingReference)}</strong> has been cancelled.</p><p>We do not process cash refunds. Instead, we have issued a rebooking voucher for the full amount paid: <strong>R ${credit.originalAmount.toFixed(2)}</strong>.</p><div style="background:#eff6ff;border:1px solid #93c5fd;border-radius:8px;padding:18px;text-align:center"><p style="margin:0;color:#1d4ed8">Your voucher code</p><p style="font-size:26px;font-weight:bold;letter-spacing:2px;margin:8px 0">${escapeHtml(credit.creditCode)}</p></div><p>This voucher never expires and may be used across multiple future bookings until the balance is depleted. It is valid for ticket purchases only and cannot be used at the kiosk for food, drinks, or merchandise.</p><p>To use it, visit <a href="${escapeHtml(bookingUrl)}">${escapeHtml(bookingUrl)}</a>, choose a date, and enter the voucher code at checkout. If your new booking costs more than the remaining voucher balance, pay the difference by EFT as usual.</p><p>For questions, contact us at <a href="mailto:${escapeHtml(supportEmail)}">${escapeHtml(supportEmail)}</a> or 072 264 4009.</p><p>We apologise for the inconvenience.</p></div>`;
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
