import { NextResponse } from 'next/server';
import nodemailer from 'nodemailer';
import { supabase } from '@/lib/supabase';
import { checkRateLimit, getClientAddress } from '@/lib/request-security';
import { escapeHtml, renderEmailLayout, calloutBox, statusBadge, buttonHtml } from '@/lib/email-layout';

export async function POST(request: Request) {
  try {
    const { reference } = await request.json();
    if (typeof reference !== 'string' || !reference.trim()) {
      return NextResponse.json({ success: false, error: 'Booking reference is required' }, { status: 400 });
    }
    const ref = reference.trim();

    // Rate-limit by booking reference (3 per 5 min) and by IP (5 per minute)
    const ip = getClientAddress(request);
    if (!(await checkRateLimit(request, 'eft-email-ref', 3, 300, ref))) {
      return NextResponse.json({ success: false, error: 'Too many requests. Please wait a moment and try again.' }, { status: 429 });
    }
    if (!(await checkRateLimit(request, 'eft-email-ip', 5, 60, ip))) {
      return NextResponse.json({ success: false, error: 'Too many requests. Please wait a moment and try again.' }, { status: 429 });
    }

    // Look up booking and customer — send to the customer's own email only
    const { data: booking, error: bookingError } = await supabase
      .from('bookings')
      .select('id, status, total_amount, amount_due, visit_date, customers(first_name, last_name, email)')
      .eq('reference', ref)
      .maybeSingle();

    // Return a generic error for all failure cases to avoid revealing booking
    // existence or status to unauthenticated callers.
    if (bookingError || !booking) {
      return NextResponse.json({ success: false, error: 'We could not send the payment instructions. Please check your booking reference and try again.' }, { status: 400 });
    }
    if (!['UNPAID', 'PAYMENT_PENDING'].includes(booking.status)) {
      return NextResponse.json({ success: false, error: 'We could not send the payment instructions. Please check your booking reference and try again.' }, { status: 400 });
    }

    const customer = Array.isArray(booking.customers) ? booking.customers[0] : booking.customers;
    const customerEmail = customer?.email;
    if (!customerEmail) {
      console.error(`EFT email: no customer email for booking ${ref}`);
      return NextResponse.json({ success: false, error: 'We could not send the payment instructions. Please contact support.' }, { status: 400 });
    }

    const payableAmount = Number(booking.amount_due ?? booking.total_amount);
    if (!Number.isFinite(payableAmount) || payableAmount <= 0) {
      return NextResponse.json({ success: false, error: 'This booking has no amount due' }, { status: 400 });
    }

    // Extend the hold window for EFT bookings so capacity is not released
    // before the customer has time to pay and upload proof.
    const holdHours = Number(process.env.EFT_HOLD_HOURS) || 48;
    if (booking.status === 'UNPAID') {
      await supabase.from('bookings').update({
        expires_at: new Date(Date.now() + holdHours * 60 * 60 * 1000).toISOString(),
      }).eq('reference', ref);
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    if (process.env.NODE_ENV === 'production' && !appUrl.startsWith('https://')) throw new Error('NEXT_PUBLIC_APP_URL must use HTTPS in production');
    const uploadUrl = `${appUrl}/upload-proof?ref=${encodeURIComponent(ref)}`;
    const htmlContent = renderEmailLayout({
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
              <tr><td style="color:#64748b;">Bank</td><td style="text-align:right;font-weight:600;">Nedbank LTD</td></tr>
              <tr><td style="color:#64748b;">Account Name</td><td style="text-align:right;font-weight:600;">ACE contractors</td></tr>
              <tr><td style="color:#64748b;">Account Number</td><td style="text-align:right;font-weight:600;">1039028861</td></tr>
              <tr><td style="color:#64748b;">Branch Code</td><td style="text-align:right;font-weight:600;">103910</td></tr>
            </table>
          </td></tr>
        </table>
        <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:12px 16px;margin:0 0 18px;">
          <p style="margin:0;color:#b91c1c;font-size:13px;"><strong>Important:</strong> Use <strong>${escapeHtml(ref)}</strong> as your payment reference so we can match your payment.</p>
        </div>
        <p>Once you have paid, upload your proof of payment so we can confirm your booking:</p>
        ${buttonHtml(uploadUrl, 'Upload Proof of Payment')}
        <p style="font-size:13px;color:#64748b;">Your booking is held for <strong>${holdHours} hours</strong> while we wait for proof of payment. Tickets are issued once our team has reviewed and approved it.</p>
      `,
    });
    const fromEmail = process.env.NODE_ENV !== 'production' ? (process.env.SMTP_FROM_ADDRESS || process.env.SMTP_USER || 'bookings@gracelandvenues.co.za') : (process.env.EMAIL_FROM_ADDRESS || 'bookings@gracelandvenues.co.za');

    if (process.env.NODE_ENV !== 'production') {
      const smtpHost = process.env.SMTP_HOST; const smtpUser = process.env.SMTP_USER; const smtpPass = process.env.SMTP_PASS;
      if (!smtpHost || !smtpUser || !smtpPass) throw new Error('SMTP is not configured. Set SMTP_HOST, SMTP_USER, and SMTP_PASS in .env.local');
      const port = Number(process.env.SMTP_PORT || 587);
      const transporter = nodemailer.createTransport({ host: smtpHost, port, secure: process.env.SMTP_SECURE === 'true' || port === 465, auth: { user: smtpUser, pass: smtpPass } });
      await transporter.sendMail({ from: `Graceland Venues <${fromEmail}>`, to: customerEmail, subject: `Payment Instructions for Booking ${ref}`, html: htmlContent });
      return NextResponse.json({ success: true });
    }

    const resendApiKey = process.env.RESEND_API_KEY;
    if (!resendApiKey || resendApiKey === 'your-resend-api-key') throw new Error('RESEND_API_KEY is not configured');
    const response = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: `Graceland Venues <${fromEmail}>`, to: [customerEmail], subject: `Payment Instructions for Booking ${ref}`, html: htmlContent }) });
    if (!response.ok) throw new Error(`Failed to send email via Resend: ${await response.text()}`);
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    console.error('EFT email failed', error);
    return NextResponse.json({ success: false, error: 'We could not send the payment instructions. Please try again or contact support.' }, { status: 500 });
  }
}
