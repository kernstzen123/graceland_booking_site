import { NextResponse } from 'next/server';
import { AdminAuthError, requireAdmin, writeAudit } from '@/lib/admin-auth';
import { supabase } from '@/lib/supabase';
import { sendVoucherEmail } from '@/lib/voucher-email';

export async function GET(request: Request) {
  try {
    await requireAdmin(request, ['ADMIN', 'MANAGER']);
    const { data, error } = await supabase.from('notification_failures').select('id,notification_type,recipient,entity_id,error_message,attempts,created_at').is('resolved_at', null).order('created_at', { ascending: false }).limit(100);
    if (error) throw error;
    return NextResponse.json({ success: true, failures: data || [] });
  } catch (error) {
    if (error instanceof AdminAuthError) return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    console.error('Notification failure list error', error);
    return NextResponse.json({ success: false, error: 'Could not load failed notifications' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const { user } = await requireAdmin(request, ['ADMIN', 'MANAGER']);
    const { failureId } = await request.json();
    const { data: failure, error: failureError } = await supabase.from('notification_failures').select('id,notification_type,entity_id,attempts').eq('id', failureId).is('resolved_at', null).single();
    if (failureError || !failure) return NextResponse.json({ success: false, error: 'Notification failure not found' }, { status: 404 });
    if (failure.notification_type !== 'VOUCHER_ISSUED') return NextResponse.json({ success: false, error: 'This notification type cannot be retried here' }, { status: 400 });
    const { data: credit, error: creditError } = await supabase.from('booking_credits').select('credit_code,original_amount,bookings(reference,visit_date,customers(first_name,last_name,email))').eq('id', failure.entity_id).single();
    if (creditError || !credit) return NextResponse.json({ success: false, error: 'Voucher for this notification could not be found' }, { status: 404 });
    const booking = Array.isArray(credit.bookings) ? credit.bookings[0] : credit.bookings;
    const customer = booking && (Array.isArray(booking.customers) ? booking.customers[0] : booking.customers);
    try {
      await sendVoucherEmail({ bookingReference: booking?.reference || '', visitDate: booking?.visit_date || '', customerEmail: customer?.email || '', customerName: customer ? `${customer.first_name} ${customer.last_name}` : 'Customer', creditCode: credit.credit_code, originalAmount: Number(credit.original_amount) });
      await supabase.from('notification_failures').update({ resolved_at: new Date().toISOString(), attempts: Number(failure.attempts || 0) + 1 }).eq('id', failure.id);
      await writeAudit(user.id, 'RETRY_VOUCHER_EMAIL', 'notification_failure', failure.id, { credit_code: credit.credit_code });
      return NextResponse.json({ success: true, message: 'Voucher email sent successfully' });
    } catch (emailError) {
      await supabase.from('notification_failures').update({ attempts: Number(failure.attempts || 0) + 1, error_message: emailError instanceof Error ? emailError.message : 'Email retry failed' }).eq('id', failure.id);
      return NextResponse.json({ success: false, error: 'Email retry failed. The failure remains queued.' }, { status: 502 });
    }
  } catch (error) {
    if (error instanceof AdminAuthError) return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    console.error('Notification retry error', error);
    return NextResponse.json({ success: false, error: 'Could not retry notification' }, { status: 500 });
  }
}
