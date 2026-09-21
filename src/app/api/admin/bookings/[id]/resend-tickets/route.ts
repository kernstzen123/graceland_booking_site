import { NextResponse } from 'next/server';
import { AdminAuthError, requireAdmin, writeAudit } from '@/lib/admin-auth';
import { supabase } from '@/lib/supabase';
import { generateTicketsAndSendEmail } from '@/lib/ticketing';
import { checkRateLimit } from '@/lib/request-security';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireAdmin(request, ['ADMIN', 'MANAGER']);
    if (!(await checkRateLimit(request, 'resend-tickets', 5, 60))) {
      return NextResponse.json({ success: false, error: 'Too many resend attempts. Please wait a minute.' }, { status: 429 });
    }
    const { id } = await params;
    const { data: booking, error } = await supabase
      .from('bookings')
      .select('id, reference, status, customers(first_name, last_name, email)')
      .eq('id', id)
      .single();
    if (error || !booking) return NextResponse.json({ success: false, error: 'Booking not found' }, { status: 404 });
    if (!['PAID', 'CONFIRMED'].includes(booking.status)) {
      return NextResponse.json({ success: false, error: 'Tickets can only be resent for PAID or CONFIRMED bookings' }, { status: 400 });
    }
    const customer = Array.isArray(booking.customers) ? booking.customers[0] : booking.customers;
    const email = customer?.email || '';
    const name = [customer?.first_name, customer?.last_name].filter(Boolean).join(' ') || 'Customer';
    if (!email) return NextResponse.json({ success: false, error: 'No customer email on file' }, { status: 400 });

    await generateTicketsAndSendEmail(booking.id, email, name);
    await writeAudit(user.id, 'RESEND_TICKETS', 'booking', booking.id, { reference: booking.reference });
    return NextResponse.json({ success: true, message: 'Tickets resent successfully' });
  } catch (error) {
    if (error instanceof AdminAuthError) return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    console.error('Resend tickets error', error);
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Could not resend tickets' }, { status: 500 });
  }
}
