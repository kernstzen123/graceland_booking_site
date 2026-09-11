import { NextResponse } from 'next/server';
import nodemailer from 'nodemailer';
import { customerError } from '@/lib/public-errors';
import { supabase } from '@/lib/supabase';

export async function POST(request: Request) {
  try {
    const { email, name, reference, totalAmount, visitDate } = await request.json();
    if (!email || !reference) return NextResponse.json({ success: false, error: 'Customer email and booking reference are required' }, { status: 400 });
    const { data: booking, error: bookingError } = await supabase.from('bookings').select('status,total_amount,amount_due,visit_date,customers(first_name,last_name,email)').eq('reference', String(reference).trim()).maybeSingle();
    if (bookingError || !booking) return NextResponse.json({ success: false, error: 'Booking could not be found' }, { status: 404 });
    if (!['UNPAID', 'PAYMENT_PENDING'].includes(booking.status)) return NextResponse.json({ success: false, error: 'This booking is no longer awaiting payment' }, { status: 400 });
    const customer = Array.isArray(booking.customers) ? booking.customers[0] : booking.customers;
    const payableAmount = Number(booking.amount_due ?? booking.total_amount);
    if (!Number.isFinite(payableAmount) || payableAmount <= 0) return NextResponse.json({ success: false, error: 'This booking has no amount due' }, { status: 400 });
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    if (process.env.NODE_ENV === 'production' && !appUrl.startsWith('https://')) throw new Error('NEXT_PUBLIC_APP_URL must use HTTPS in production');
    const escapeHtml = (value: unknown) => String(value || '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
    const uploadUrl = `${appUrl}/upload-proof?ref=${encodeURIComponent(reference)}`;
    const htmlContent = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#0f172a"><h2 style="color:#0EA5E9">Graceland Venues - Payment Instructions</h2><p>Hi ${escapeHtml(customer?.first_name || name)},</p><p>Thank you for booking with us. Your booking reference is <strong>${escapeHtml(reference)}</strong>.</p><p>Visit date: <strong>${escapeHtml(booking.visit_date || visitDate || 'As selected during booking')}</strong></p><p>Please transfer <strong>R ${escapeHtml(payableAmount)}</strong> to the following account:</p><ul style="background:#f8fafc;padding:15px;list-style:none;border-radius:5px"><li><strong>Bank:</strong> FNB</li><li><strong>Account Name:</strong> Graceland Venues</li><li><strong>Account Number:</strong> 62000000000</li><li><strong>Branch Code:</strong> 250655</li></ul><p style="color:#ef4444"><strong>IMPORTANT:</strong> Use <strong>${escapeHtml(reference)}</strong> as your payment reference.</p><p>After payment, upload your proof using the link below:</p><p><a href="${uploadUrl}" style="display:inline-block;padding:10px 20px;background:#0EA5E9;color:white;text-decoration:none;border-radius:5px">Upload Proof of Payment</a></p><p>Your booking will only be confirmed and tickets issued after your proof has been reviewed and approved by our team.</p></div>`;
    const fromEmail = process.env.NODE_ENV !== 'production' ? (process.env.SMTP_FROM_ADDRESS || process.env.SMTP_USER || 'bookings@gracelandvenues.co.za') : (process.env.EMAIL_FROM_ADDRESS || 'bookings@gracelandvenues.co.za');

    if (process.env.NODE_ENV !== 'production') {
      const smtpHost = process.env.SMTP_HOST; const smtpUser = process.env.SMTP_USER; const smtpPass = process.env.SMTP_PASS;
      if (!smtpHost || !smtpUser || !smtpPass) throw new Error('SMTP is not configured. Set SMTP_HOST, SMTP_USER, and SMTP_PASS in .env.local');
      const port = Number(process.env.SMTP_PORT || 587);
      const transporter = nodemailer.createTransport({ host: smtpHost, port, secure: process.env.SMTP_SECURE === 'true' || port === 465, auth: { user: smtpUser, pass: smtpPass } });
      await transporter.sendMail({ from: `Graceland Venues <${fromEmail}>`, to: email, subject: `Payment Instructions for Booking ${reference}`, html: htmlContent });
      return NextResponse.json({ success: true });
    }

    const resendApiKey = process.env.RESEND_API_KEY;
    if (!resendApiKey || resendApiKey === 'your-resend-api-key') throw new Error('RESEND_API_KEY is not configured');
    const response = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: `Graceland Venues <${fromEmail}>`, to: [email], subject: `Payment Instructions for Booking ${reference}`, html: htmlContent }) });
    if (!response.ok) throw new Error(`Failed to send email via Resend: ${await response.text()}`);
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    console.error('EFT email failed', error);
    return NextResponse.json({ success: false, error: customerError(error, 'We could not send the payment instructions. Please try again or contact support.') }, { status: 500 });
  }
}
