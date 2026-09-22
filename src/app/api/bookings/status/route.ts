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
    .select('status, notes, expires_at, total_amount, amount_due, visit_date')
    .eq('reference', reference)
    .maybeSingle();

  // Return the same generic message for DB errors and missing bookings
  if (error || !booking) return NextResponse.json({ success: false, error: 'Booking not found' }, { status: 404 });

  const expired = ['UNPAID', 'PAYMENT_PENDING'].includes(booking.status) && booking.expires_at && new Date(booking.expires_at).getTime() <= Date.now();
  const failed = booking.status === 'PAYMENT_FAILED' || booking.notes?.includes('PAYFAST_FAILED');

  // Return only what the customer needs to see their own status — NO PII.
  return NextResponse.json({
    success: true,
    status: booking.status,
    paymentState: failed ? 'FAILED' : expired ? 'EXPIRED' : booking.status === 'PAID' ? 'PAID' : 'PENDING',
    ready: booking.status === 'PAID' && booking.notes?.includes('TICKETS_EMAIL_SENT'),
    amountDue: Number(booking.amount_due ?? booking.total_amount ?? 0),
    visitDate: booking.visit_date ?? null,
    // customer object intentionally omitted — PII must not be exposed via
    // an unauthenticated, guessable endpoint. The client persists customer
    // details in sessionStorage before the PayFast redirect.
  });
}
