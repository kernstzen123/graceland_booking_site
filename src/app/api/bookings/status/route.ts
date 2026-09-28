import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { checkRateLimit, getClientAddress } from '@/lib/request-security';

export async function GET(request: Request) {
  const reference = new URL(request.url).searchParams.get('reference')?.trim();
  if (!reference) return NextResponse.json({ success: false, error: 'Reference is required' }, { status: 400 });

  // Rate-limit by IP (10/min) and by reference (5/min) to prevent enumeration
  const ip = getClientAddress(request);
  if (!(await checkRateLimit(request, 'status-ip', 10, 60, ip))) {
    return NextResponse.json({ success: false, error: 'Too many requests. Please wait a moment and try again.' }, { status: 429 });
  }
  if (!(await checkRateLimit(request, 'status-ref', 5, 60, reference))) {
    return NextResponse.json({ success: false, error: 'Too many requests. Please wait a moment and try again.' }, { status: 429 });
  }

  const { data: booking, error } = await supabase
    .from('bookings')
    .select('status, notes, expires_at, total_amount, amount_due, visit_date, tickets_emailed_at, payment_failed_at')
    .eq('reference', reference)
    .maybeSingle();

  // Return the same generic message for DB errors and missing bookings
  if (error || !booking) return NextResponse.json({ success: false, error: 'Booking not found' }, { status: 404 });

  const paid = ['PAID', 'CONFIRMED'].includes(booking.status);
  const expired = ['UNPAID', 'PAYMENT_PENDING'].includes(booking.status) && booking.expires_at && new Date(booking.expires_at).getTime() <= Date.now();
  // A failed PayFast attempt can be followed by a successful retry, so a paid
  // booking is never reported as failed. (The notes markers are from bookings
  // made before these columns existed.)
  const failed = !paid && (booking.status === 'PAYMENT_FAILED' || Boolean(booking.payment_failed_at) || Boolean(booking.notes?.includes('PAYFAST_FAILED')));
  const ticketsEmailed = Boolean(booking.tickets_emailed_at) || Boolean(booking.notes?.includes('TICKETS_EMAIL_SENT'));

  // Return only what the customer needs to see their own status — NO PII.
  return NextResponse.json({
    success: true,
    status: booking.status,
    paymentState: paid ? 'PAID' : failed ? 'FAILED' : expired ? 'EXPIRED' : 'PENDING',
    ready: paid && ticketsEmailed,
    amountDue: Number(booking.amount_due ?? booking.total_amount ?? 0),
    visitDate: booking.visit_date ?? null,
    // customer object intentionally omitted — PII must not be exposed via
    // an unauthenticated, guessable endpoint. The client persists customer
    // details in sessionStorage before the PayFast redirect.
  });
}
