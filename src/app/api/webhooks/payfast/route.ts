import crypto from 'crypto';
import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { generateTicketsAndSendEmail } from '@/lib/ticketing';
import { recordNotificationFailure } from '@/lib/voucher-email';
import { requireEnv } from '@/lib/env';

function isValidSignature(params: URLSearchParams) {
  const received = params.get('signature');
  // The local developer simulation intentionally has no PayFast signature.
  if (!received && process.env.NODE_ENV !== 'production') return true;
  if (!received) return false;

  const values: string[] = [];
  for (const [key, value] of params) {
    // PayFast includes empty ITN fields in the signature string.
    if (key !== 'signature') values.push(`${key}=${encodeURIComponent(value).replace(/%20/g, '+')}`);
  }
  const passphrase = requireEnv('PAYFAST_PASSPHRASE', '').trim();
  if (passphrase) values.push(`passphrase=${encodeURIComponent(passphrase).replace(/%20/g, '+')}`);
  const expected = crypto.createHash('md5').update(values.join('&')).digest('hex');
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(received);
  return expectedBuffer.length === receivedBuffer.length && crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

async function verifyWithPayFast(params: URLSearchParams) {
  // The unsigned local simulator is deliberately supported only in development.
  if (!params.get('signature') && process.env.NODE_ENV !== 'production') return true;
  const processUrl = requireEnv('PAYFAST_URL', 'https://sandbox.payfast.co.za/eng/process');
  const validationUrl = processUrl.replace(/\/eng\/process(?:\?.*)?\/?$/i, '/eng/query/validate');
  const response = await fetch(validationUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/plain' },
    body: params.toString(),
    signal: AbortSignal.timeout(10000),
    cache: 'no-store',
  });
  const result = (await response.text()).trim();
  return response.ok && result === 'VALID';
}

export async function POST(request: Request) {
  try {
    const params = new URLSearchParams(await request.text());
    const paymentStatus = params.get('payment_status');
    const reference = params.get('m_payment_id');
    if (!reference) return new NextResponse('OK', { status: 200 });
    if (!isValidSignature(params)) return new NextResponse('Invalid signature', { status: 400 });
    if (params.get('merchant_id') && params.get('merchant_id') !== process.env.PAYFAST_MERCHANT_ID?.trim()) return new NextResponse('Invalid merchant', { status: 400 });
    if (!(await verifyWithPayFast(params))) return new NextResponse('PayFast validation failed', { status: 400 });

    const { data: booking, error: bookingError } = await supabase
      .from('bookings')
      .select('id, total_amount, amount_due, notes, customers(first_name, last_name, email)')
      .eq('reference', reference)
      .single();
    if (bookingError || !booking) throw new Error(`Booking ${reference} was not found`);

    if (paymentStatus !== 'COMPLETE') {
      if (['FAILED', 'CANCELLED'].includes(paymentStatus || '')) {
        await supabase.from('bookings').update({ status: 'PAYMENT_FAILED', notes: `${booking.notes ? `${booking.notes}\n` : ''}PAYFAST_FAILED` }).eq('id', booking.id);
      }
      return new NextResponse('OK', { status: 200 });
    }

    // PayFast ITN notifications use amount_gross. Keep amount as a fallback
    // for the local development simulator and older integrations.
    const expectedAmount = Number(booking.amount_due ?? booking.total_amount);
    const submittedAmount = params.get('amount_gross') || params.get('amount');
    const amount = submittedAmount
      ? Number(submittedAmount)
      : process.env.NODE_ENV !== 'production'
        ? expectedAmount
        : Number.NaN;
    // Compare in whole cents to avoid floating-point mismatch
    if (!Number.isFinite(amount) || Math.round(amount * 100) !== Math.round(expectedAmount * 100)) {
      return new NextResponse('Amount mismatch', { status: 400 });
    }

    // PayFast may retry an ITN. Once the email has been sent, acknowledge
    // retries without issuing a second set of tickets or another email.
    if (booking.notes?.includes('TICKETS_EMAIL_SENT')) {
      return new NextResponse('OK', { status: 200 });
    }

    const providerReference = params.get('pf_payment_id') || reference;
    const { data: existingPayment, error: existingPaymentError } = await supabase
      .from('payments').select('id').eq('provider_reference', providerReference).maybeSingle();
    if (existingPaymentError) throw existingPaymentError;

    if (!existingPayment) {
      const { error: bookingUpdateError } = await supabase
        .from('bookings').update({ status: 'PAID', payment_method: 'PAYFAST' }).eq('id', booking.id);
      if (bookingUpdateError) throw bookingUpdateError;
      const { error: paymentError } = await supabase.from('payments').insert({
        booking_id: booking.id, amount, method: 'PAYFAST', status: 'COMPLETE', provider_reference: providerReference,
      });
      if (paymentError) {
        // Another simultaneous ITN already claimed this provider transaction.
        if (paymentError.code === '23505') return new NextResponse('OK', { status: 200 });
        throw paymentError;
      }
    }

    const customer = Array.isArray(booking.customers) ? booking.customers[0] : booking.customers;
    const email = customer?.email || params.get('email_address') || '';
    const name = [customer?.first_name, customer?.last_name].filter(Boolean).join(' ') || params.get('name_first') || 'Customer';

    try {
      await generateTicketsAndSendEmail(booking.id, email, name);
      // Only write TICKETS_EMAIL_SENT after successful delivery
      const notes = booking.notes ? `${booking.notes}\nTICKETS_EMAIL_SENT` : 'TICKETS_EMAIL_SENT';
      const { error: notesError } = await supabase.from('bookings').update({ notes }).eq('id', booking.id);
      if (notesError) throw notesError;
      console.log(`PayFast payment confirmed and tickets emailed for ${reference}`);
    } catch (emailError) {
      // Email delivery failed — do NOT write TICKETS_EMAIL_SENT.
      // Record the failure for admin visibility and return 500 so PayFast retries.
      // Existing tickets are reused on retry (ticketing.ts checks for them first),
      // and the payment row is protected by a unique constraint on provider_reference.
      console.error(`Ticket email delivery failed for ${reference}`, emailError);
      await recordNotificationFailure('booking', 'TICKETS_EMAIL_FAILED', email, booking.id, emailError);
      return new NextResponse('Email delivery failed', { status: 500 });
    }

    return new NextResponse('OK', { status: 200 });
  } catch (error) {
    console.error('PayFast webhook error', error);
    const message = error instanceof Error ? error.message : 'Unknown webhook error';
    return new NextResponse(`Webhook error: ${message}`, { status: 500 });
  }
}
