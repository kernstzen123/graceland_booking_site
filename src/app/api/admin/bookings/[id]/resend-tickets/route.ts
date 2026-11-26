import { NextResponse } from 'next/server';
import { AdminAuthError, requireAdmin, writeAudit } from '@/lib/admin-auth';
import { supabase } from '@/lib/supabase';
import { generateTicketsAndSendEmail } from '@/lib/ticketing';
import { checkRateLimit } from '@/lib/request-security';
import { bookingIsActive } from '@/lib/booking-card';

/**
 * "Send booking QR": email the customer their booking QR code (one code for the
 * whole booking) with the booking summary. Works for paid bookings, and for
 * unpaid ones that still hold their places (the email then says what is owed).
 * Tickets are made first if the booking has none yet (no other email is sent).
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireAdmin(request, ['ADMIN', 'MANAGER']);
    if (!(await checkRateLimit(request, 'resend-tickets', 5, 60))) {
      return NextResponse.json({ success: false, error: 'Too many resend attempts. Please wait a minute.' }, { status: 429 });
    }
    const { id } = await params;
    const { data: booking, error } = await supabase
      .from('bookings')
      .select('id, reference, status, expires_at, deleted_at, voucher_issued, customers(first_name, last_name, email)')
      .eq('id', id)
      .single();
    if (error || !booking) return NextResponse.json({ success: false, error: 'Booking not found' }, { status: 404 });
    if (!bookingIsActive(booking)) {
      return NextResponse.json({ success: false, error: 'This booking is cancelled, deleted or was not paid in time, so its QR code cannot be sent.' }, { status: 400 });
    }
    const customer = Array.isArray(booking.customers) ? booking.customers[0] : booking.customers;
    const email = customer?.email || '';
    const name = [customer?.first_name, customer?.last_name].filter(Boolean).join(' ') || 'Customer';
    if (!email) return NextResponse.json({ success: false, error: 'No customer email on file' }, { status: 400 });

    await generateTicketsAndSendEmail(booking.id, email, name);
    await writeAudit(user.id, 'SEND_BOOKING_QR', 'booking', booking.id, { reference: booking.reference, status: booking.status });
    return NextResponse.json({ success: true, message: 'Booking QR code emailed' });
  } catch (error) {
    if (error instanceof AdminAuthError) return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    console.error('Resend tickets error', error);
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Could not send the booking QR code' }, { status: 500 });
  }
}
