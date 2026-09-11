import { NextResponse } from 'next/server';
import { AdminAuthError, requireAdmin, writeAudit } from '@/lib/admin-auth';
import { supabase } from '@/lib/supabase';
import { generateTicketsAndSendEmail } from '@/lib/ticketing';
import { recordNotificationFailure, sendVoucherEmail } from '@/lib/voucher-email';

export async function GET(request: Request) {
  try {
    await requireAdmin(request, ['ADMIN', 'MANAGER']);
    const query = new URL(request.url).searchParams.get('q')?.trim().toLowerCase() || '';
    const { data, error } = await supabase
      .from('bookings')
      .select('id,reference,visit_date,status,payment_method,total_amount,people_count,created_at,expires_at,notes,refunded_at,voucher_issued,voucher_amount_used,amount_due,customers(first_name,last_name,email,phone),booking_items(id,quantity,price_per_unit,subtotal,metadata,packages(name),huts(name)),payments(id,amount,method,status,provider_reference,created_at),payment_proofs(id,file_url,status,admin_notes,uploaded_at,verified_at),tickets(id,ticket_uid,qr_token,status,visit_date,issued_at)')
      .order('created_at', { ascending: false }).limit(500);
    if (error) throw error;

    const bookings = (data || []).filter(booking => {
      if (!query) return true;
      const customer = Array.isArray(booking.customers) ? booking.customers[0] : booking.customers;
      const searchable = [booking.reference, customer?.first_name, customer?.last_name, customer?.email, ...(booking.tickets || []).map(ticket => ticket.ticket_uid)].filter(Boolean).join(' ').toLowerCase();
      return searchable.includes(query);
    });
    return NextResponse.json({ success: true, bookings });
  } catch (error) {
    if (error instanceof AdminAuthError) return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    console.error('Admin bookings list error', error);
    return NextResponse.json({ success: false, error: 'Could not load bookings' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const { user } = await requireAdmin(request, ['ADMIN', 'MANAGER']);
    const { bookingId, action, ticketId, reason } = await request.json();
    if (!bookingId || !['resend_tickets', 'delete', 'mark_paid', 'refund', 'cancel_ticket'].includes(action)) return NextResponse.json({ success: false, error: 'Invalid booking action' }, { status: 400 });
    const { data: booking, error } = await supabase.from('bookings').select('id,reference,status,total_amount,customers(first_name,last_name,email),tickets(id,ticket_uid,status)').eq('id', bookingId).single();
    if (error || !booking) return NextResponse.json({ success: false, error: 'Booking not found' }, { status: 404 });
    const customer = Array.isArray(booking.customers) ? booking.customers[0] : booking.customers;

    if (action === 'resend_tickets') {
      if (!booking.tickets?.length) return NextResponse.json({ success: false, error: 'This booking has no tickets to send' }, { status: 400 });
      await generateTicketsAndSendEmail(booking.id, customer?.email || '', [customer?.first_name, customer?.last_name].filter(Boolean).join(' ') || 'Customer');
      await writeAudit(user.id, 'RESEND_TICKETS', 'booking', booking.id, { reference: booking.reference });
      return NextResponse.json({ success: true, message: 'Ticket email sent' });
    }

    if (action === 'mark_paid') {
      if (booking.status === 'REFUNDED' || booking.status === 'CANCELLED') return NextResponse.json({ success: false, error: 'Cancelled or refunded bookings cannot be marked paid' }, { status: 400 });
      const { error: bookingError } = await supabase.from('bookings').update({ status: 'PAID', payment_method: 'ADMIN_OVERRIDE' }).eq('id', booking.id);
      if (bookingError) throw bookingError;
      const { data: existingPayment } = await supabase.from('payments').select('id').eq('booking_id', booking.id).eq('status', 'COMPLETE').maybeSingle();
      if (!existingPayment) {
        const { error: paymentError } = await supabase.from('payments').insert({ booking_id: booking.id, amount: booking.total_amount, method: 'ADMIN_OVERRIDE', status: 'COMPLETE', provider_reference: `ADMIN-${booking.id}` });
        if (paymentError) throw paymentError;
      }
      await generateTicketsAndSendEmail(booking.id, customer?.email || '', [customer?.first_name, customer?.last_name].filter(Boolean).join(' ') || 'Customer');
      await writeAudit(user.id, 'MARK_PAID', 'booking', booking.id, { reference: booking.reference, reason: reason || null });
      return NextResponse.json({ success: true, message: 'Booking marked paid and tickets issued' });
    }

    if (action === 'refund') {
      const { data: result, error: refundError } = await supabase.rpc('issue_booking_voucher', { p_booking_id: booking.id, p_created_by: user.id });
      if (refundError) throw refundError;
      const credit = Array.isArray(result) ? result[0] : result;
      if (!credit) return NextResponse.json({ success: false, error: 'Voucher could not be issued' }, { status: 400 });
      let emailSent = true;
      try { await sendVoucherEmail({ bookingReference: credit.booking_reference, visitDate: credit.visit_date, customerEmail: credit.customer_email || customer?.email || '', customerName: credit.customer_name || 'Customer', creditCode: credit.credit_code, originalAmount: Number(credit.original_amount) }); } catch (emailError) { emailSent = false; await recordNotificationFailure('VOUCHER_ISSUED', credit.customer_email || customer?.email || '', credit.credit_id, emailError); }
      await writeAudit(user.id, 'ISSUE_VOUCHER_REFUND', 'booking', booking.id, { reference: booking.reference, reason: reason || null, amount: credit.original_amount, credit_code: credit.credit_code });
      return NextResponse.json({ success: true, emailSent, message: emailSent ? 'Booking cancelled and voucher issued. Email sent.' : 'Booking cancelled and voucher issued. Email queued for retry.' });
    }

    if (action === 'cancel_ticket') {
      if (!ticketId || !booking.tickets?.some(ticket => ticket.id === ticketId)) return NextResponse.json({ success: false, error: 'Ticket not found for this booking' }, { status: 404 });
      const { error: ticketError } = await supabase.from('tickets').update({ status: 'CANCELLED' }).eq('id', ticketId).eq('booking_id', booking.id).eq('status', 'VALID');
      if (ticketError) throw ticketError;
      await writeAudit(user.id, 'CANCEL_TICKET', 'ticket', ticketId, { booking_id: booking.id, reference: booking.reference, reason: reason || null });
      return NextResponse.json({ success: true, message: 'Ticket cancelled and invalidated' });
    }

    if (!['ADMIN'].includes((await requireAdmin(request, ['ADMIN'])).role)) return NextResponse.json({ success: false, error: 'Only admins can delete bookings' }, { status: 403 });
    await writeAudit(user.id, 'DELETE_BOOKING', 'booking', booking.id, { reference: booking.reference });
    const { error: deleteError } = await supabase.from('bookings').delete().eq('id', booking.id);
    if (deleteError) throw deleteError;
    return NextResponse.json({ success: true, message: 'Booking deleted' });
  } catch (error) {
    if (error instanceof AdminAuthError) return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    console.error('Admin booking action error', error);
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Could not process booking action' }, { status: 500 });
  }
}
