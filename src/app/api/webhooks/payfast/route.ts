import crypto from 'crypto';
import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { generateTicketsAndSendEmail } from '@/lib/ticketing';
import { recordNotificationFailure } from '@/lib/voucher-email';
import { requireEnv } from '@/lib/env';
import { flagBookingForReview, setBookingPaymentStatus } from '@/lib/booking-holds';

const isProduction = () => process.env.NODE_ENV === 'production';
const ok = () => new NextResponse('OK', { status: 200 });
const rands = (value: number) => `R ${value.toFixed(2)}`;

/** The local developer simulator posts ITNs without a signature. Only allowed outside production. */
const isLocalSimulation = (params: URLSearchParams) => !params.get('signature') && !isProduction();

function isValidSignature(params: URLSearchParams) {
  if (isLocalSimulation(params)) return true;
  const received = params.get('signature');
  if (!received) return false;

  const values: string[] = [];
  for (const [key, value] of params) {
    // PayFast includes empty ITN fields in the signature string.
    if (key !== 'signature') values.push(`${key}=${encodeURIComponent(value).replace(/%20/g, '+')}`);
  }
  // Required in production (requireEnv throws if it is missing), so a forged
  // notification cannot be signed without knowing the secret.
  const passphrase = requireEnv('PAYFAST_PASSPHRASE', '');
  if (passphrase) values.push(`passphrase=${encodeURIComponent(passphrase).replace(/%20/g, '+')}`);
  const expected = crypto.createHash('md5').update(values.join('&')).digest('hex');
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(received);
  return expectedBuffer.length === receivedBuffer.length && crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

function isOurMerchant(params: URLSearchParams) {
  if (isLocalSimulation(params)) return true;
  const merchantId = params.get('merchant_id')?.trim();
  return Boolean(merchantId) && merchantId === requireEnv('PAYFAST_MERCHANT_ID').trim();
}

async function verifyWithPayFast(params: URLSearchParams) {
  if (isLocalSimulation(params)) return true;
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

function appendNote(notes: string | null | undefined, note: string) {
  return notes ? `${notes}\n${note}` : note;
}

/**
 * Record a PayFast payment. Returns false when this transaction could not be
 * recorded because the booking already has a different PayFast payment.
 */
async function recordPayment(bookingId: string, amount: number, providerReference: string) {
  const { error } = await supabase.from('payments').insert({
    booking_id: bookingId, amount, method: 'PAYFAST', status: 'COMPLETE', provider_reference: providerReference,
  });
  if (!error) return true;
  if (error.code !== '23505') throw error;
  // Unique violation: either this exact transaction was already recorded (a
  // retried notification), or another PayFast payment exists for the booking.
  const { data: existing, error: lookupError } = await supabase.from('payments').select('id').eq('provider_reference', providerReference).maybeSingle();
  if (lookupError) throw lookupError;
  return Boolean(existing);
}

export async function POST(request: Request) {
  try {
    const params = new URLSearchParams(await request.text());
    const paymentStatus = params.get('payment_status');
    const reference = params.get('m_payment_id');
    if (!reference) return ok();
    if (!isValidSignature(params)) return new NextResponse('Invalid signature', { status: 400 });
    if (!isOurMerchant(params)) return new NextResponse('Invalid merchant', { status: 400 });
    if (!(await verifyWithPayFast(params))) return new NextResponse('PayFast validation failed', { status: 400 });

    const { data: booking, error: bookingError } = await supabase
      .from('bookings')
      .select('id, status, total_amount, amount_due, notes, customers(first_name, last_name, email)')
      .eq('reference', reference)
      .maybeSingle();
    if (bookingError) throw bookingError;
    if (!booking) {
      // A genuine, validated notification for a reference we do not have. Retrying will not help.
      console.error(`PayFast notification for unknown booking ${reference}`);
      return ok();
    }

    if (paymentStatus !== 'COMPLETE') {
      if (['FAILED', 'CANCELLED'].includes(paymentStatus || '')) {
        // Only an unpaid booking becomes PAYMENT_FAILED (which releases its hold).
        // A booking with an EFT proof under review keeps its hold; paid and
        // cancelled bookings are left alone.
        if (booking.status === 'UNPAID') {
          const { error } = await supabase.from('bookings').update({ status: 'PAYMENT_FAILED', notes: appendNote(booking.notes, 'PAYFAST_FAILED') }).eq('id', booking.id).eq('status', 'UNPAID');
          if (error) throw error;
        } else if (booking.status === 'PAYMENT_PENDING') {
          const { error } = await supabase.from('bookings').update({ notes: appendNote(booking.notes, 'PAYFAST_FAILED') }).eq('id', booking.id);
          if (error) throw error;
        }
      }
      return ok();
    }

    const providerReference = params.get('pf_payment_id') || reference;
    // PayFast ITN notifications use amount_gross. Keep amount as a fallback
    // for the local development simulator and older integrations.
    const expectedAmount = Number(booking.amount_due ?? booking.total_amount);
    const submittedAmount = params.get('amount_gross') || params.get('amount');
    const amount = submittedAmount
      ? Number(submittedAmount)
      : isLocalSimulation(params)
        ? expectedAmount
        : Number.NaN;

    // Compare in whole cents to avoid floating-point mismatch
    if (!Number.isFinite(amount) || Math.round(amount * 100) !== Math.round(expectedAmount * 100)) {
      if (Number.isFinite(amount) && amount > 0) await recordPayment(booking.id, amount, providerReference);
      await flagBookingForReview(booking.id, `PayFast payment ${providerReference} was for ${Number.isFinite(amount) ? rands(amount) : 'an unknown amount'}, but ${rands(expectedAmount)} was due, so no tickets were issued. Check the payment in PayFast, then mark the booking paid or refund the payment.`);
      return ok();
    }

    const { data: existingPayment, error: existingPaymentError } = await supabase
      .from('payments').select('id').eq('provider_reference', providerReference).maybeSingle();
    if (existingPaymentError) throw existingPaymentError;

    if (['PAID', 'CONFIRMED'].includes(booking.status)) {
      if (!existingPayment) {
        // A second, separate payment for a booking that was already paid.
        await recordPayment(booking.id, amount, providerReference);
        await flagBookingForReview(booking.id, `A second payment was received: PayFast ${providerReference} for ${rands(amount)}, but the booking was already paid. Refund one of the payments in PayFast.`);
        return ok();
      }
      // A retried notification for a payment we already confirmed: make sure the tickets went out.
    } else if (['CANCELLED', 'REFUNDED'].includes(booking.status)) {
      await recordPayment(booking.id, amount, providerReference);
      await flagBookingForReview(booking.id, `PayFast payment ${providerReference} for ${rands(amount)} was received after this booking was cancelled. Refund it in PayFast, or contact the customer.`);
      return ok();
    } else {
      // Record the money first so it is never lost, even if the booking can no
      // longer be confirmed below.
      if (!existingPayment && !(await recordPayment(booking.id, amount, providerReference))) {
        await flagBookingForReview(booking.id, `A second PayFast payment (${providerReference}, ${rands(amount)}) was received for this booking and could not be recorded automatically. Check both payments in PayFast.`);
        return ok();
      }
      // If the reservation lapsed while the customer was paying, the date,
      // seating and voucher are re-checked under the booking locks.
      const result = await setBookingPaymentStatus(booking.id, 'PAID', { paymentMethod: 'PAYFAST' });
      if (!result.ok && result.reason !== 'ALREADY_PAID') {
        await flagBookingForReview(booking.id, `Paid via PayFast (${providerReference}, ${rands(amount)}) after the reservation expired, but the booking could not be confirmed: ${result.detail} An admin can still mark it paid (accepting the overbooking), or refund the payment in PayFast.`);
        return ok();
      }
    }

    // PayFast may retry an ITN. Once the email has been sent, acknowledge
    // retries without issuing a second set of tickets or another email.
    const { data: current, error: currentError } = await supabase.from('bookings').select('notes').eq('id', booking.id).single();
    if (currentError) throw currentError;
    if (current.notes?.includes('TICKETS_EMAIL_SENT')) return ok();

    const customer = Array.isArray(booking.customers) ? booking.customers[0] : booking.customers;
    const email = customer?.email || params.get('email_address') || '';
    const name = [customer?.first_name, customer?.last_name].filter(Boolean).join(' ') || params.get('name_first') || 'Customer';

    try {
      await generateTicketsAndSendEmail(booking.id, email, name);
      // Only write TICKETS_EMAIL_SENT after successful delivery
      const { error: notesError } = await supabase.from('bookings').update({ notes: appendNote(current.notes, 'TICKETS_EMAIL_SENT') }).eq('id', booking.id);
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

    return ok();
  } catch (error) {
    // Details stay in the server log; PayFast only needs to know to retry.
    console.error('PayFast webhook error', error);
    return new NextResponse('Webhook error', { status: 500 });
  }
}
