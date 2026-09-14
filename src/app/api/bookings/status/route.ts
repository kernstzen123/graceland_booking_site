import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function GET(request: Request) {
  const reference = new URL(request.url).searchParams.get('reference')?.trim();
  if (!reference) return NextResponse.json({ success: false, error: 'Reference is required' }, { status: 400 });

  const { data: booking, error } = await supabase
    .from('bookings')
    .select('status, notes, expires_at, total_amount, amount_due, visit_date, customers(first_name, last_name, email, phone)')
    .eq('reference', reference)
    .maybeSingle();

  if (error) return NextResponse.json({ success: false, error: 'Could not check booking status' }, { status: 500 });
  if (!booking) return NextResponse.json({ success: false, error: 'Booking not found' }, { status: 404 });

  const expired = ['UNPAID', 'PAYMENT_PENDING'].includes(booking.status) && booking.expires_at && new Date(booking.expires_at).getTime() <= Date.now();
  const failed = booking.status === 'PAYMENT_FAILED' || booking.notes?.includes('PAYFAST_FAILED');
  const customer = Array.isArray(booking.customers) ? booking.customers[0] : booking.customers;
  return NextResponse.json({
    success: true,
    status: booking.status,
    paymentState: failed ? 'FAILED' : expired ? 'EXPIRED' : booking.status === 'PAID' ? 'PAID' : 'PENDING',
    ready: booking.status === 'PAID' && booking.notes?.includes('TICKETS_EMAIL_SENT'),
    amountDue: Number(booking.amount_due ?? booking.total_amount ?? 0),
    visitDate: booking.visit_date ?? null,
    customer: customer ? {
      firstName: customer.first_name ?? '',
      lastName: customer.last_name ?? '',
      email: customer.email ?? '',
      phone: customer.phone ?? '',
    } : null,
  });
}
