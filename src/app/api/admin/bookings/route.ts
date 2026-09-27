import { NextResponse } from 'next/server';
import { AdminAuthError, requireAdmin, writeAudit } from '@/lib/admin-auth';
import { supabase } from '@/lib/supabase';
import { generateTicketsAndSendEmail } from '@/lib/ticketing';
import { recordNotificationFailure } from '@/lib/voucher-email';
import { archiveBooking, FORCEABLE_FAILURES, setBookingPaymentStatus } from '@/lib/booking-holds';

const DETAIL_FIELDS = 'id,reference,visit_date,status,payment_method,total_amount,people_count,created_at,expires_at,notes,refunded_at,voucher_issued,voucher_amount_used,amount_due,deleted_at,delete_reason,attention_reason,attention_at,customers(first_name,last_name,email,phone),booking_items(id,quantity,price_per_unit,subtotal,metadata,packages(name),huts(name)),payments(id,amount,method,status,provider_reference,created_at),payment_proofs(id,file_url,status,admin_notes,uploaded_at,verified_at),tickets(id,ticket_uid,qr_token,status,visit_date,issued_at)';
const STATUS_FILTERS = ['PAID', 'PENDING', 'CANCELLED', 'FAILED', 'ATTENTION', 'DELETED'];
const ACTIONS = ['resend_tickets', 'delete', 'mark_paid', 'cancel_ticket', 'resolve_attention'];
const PAGE_SIZE = 50;

/** Staff notes for the audit log: single line, at most 300 characters. */
function cleanReason(value: unknown) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 300) : '';
}

/**
 * GET ?id=… — one booking with everything the detail panel shows.
 * GET ?q=&status=&date=&page= — one page of slim rows for the list, searched and
 * filtered in the database (reference, customer name or email, or ticket ID).
 */
export async function GET(request: Request) {
  try {
    await requireAdmin(request, ['ADMIN', 'MANAGER']);
    const params = new URL(request.url).searchParams;

    const id = params.get('id');
    if (id) {
      const { data, error } = await supabase.from('bookings').select(DETAIL_FIELDS).eq('id', id).maybeSingle();
      if (error) throw error;
      if (!data) return NextResponse.json({ success: false, error: 'Booking not found' }, { status: 404 });
      return NextResponse.json({ success: true, booking: data });
    }

    const query = params.get('q')?.trim().slice(0, 100) || null;
    const status = params.get('status')?.toUpperCase() || '';
    const date = params.get('date') || '';
    const page = Math.max(1, Math.min(10000, Number.parseInt(params.get('page') || '1', 10) || 1));
    const { data, error } = await supabase.rpc('admin_search_bookings', {
      p_query: query,
      p_status: STATUS_FILTERS.includes(status) ? status : null,
      p_visit_date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
      p_limit: PAGE_SIZE,
      p_offset: (page - 1) * PAGE_SIZE,
    });
    if (error) {
      if (error.code === 'PGRST202') return NextResponse.json({ success: false, error: 'The bookings list needs the latest database migration (supabase/migrations/20260927_security_hardening.sql).' }, { status: 500 });
      throw error;
    }
    const rows = (data || []) as Array<{ id: string; reference: string; visit_date: string; status: string; payment_method: string | null; total_amount: number; people_count: number; voucher_issued: boolean; created_at: string; first_name: string | null; last_name: string | null; email: string | null; attention_reason?: string | null; deleted_at?: string | null; total_count: number }>;
    return NextResponse.json({
      success: true,
      page,
      pageSize: PAGE_SIZE,
      total: rows.length ? Number(rows[0].total_count) : 0,
      bookings: rows.map(row => ({
        id: row.id, reference: row.reference, visit_date: row.visit_date, status: row.status, payment_method: row.payment_method,
        total_amount: row.total_amount, people_count: row.people_count, voucher_issued: row.voucher_issued, created_at: row.created_at,
        attention_reason: row.attention_reason || null, deleted_at: row.deleted_at || null,
        customers: { first_name: row.first_name, last_name: row.last_name, email: row.email },
      })),
    });
  } catch (error) {
    if (error instanceof AdminAuthError) return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    console.error('Admin bookings list error', error);
    return NextResponse.json({ success: false, error: 'Could not load bookings' }, { status: 500 });
  }
}

/**
 * POST { bookingId, action, reason?, ticketId?, force? }
 * Refunds are not handled here: they go through /api/admin/bookings/[id]/refund,
 * which only admins can use.
 */
export async function POST(request: Request) {
  try {
    const { user, role } = await requireAdmin(request, ['ADMIN', 'MANAGER']);
    const body = await request.json();
    const { bookingId, action, ticketId } = body || {};
    const reason = cleanReason(body?.reason);
    if (action === 'refund') return NextResponse.json({ success: false, error: 'Use "Voucher refund" on the booking. Only admins can issue refunds.' }, { status: 400 });
    if (typeof bookingId !== 'string' || !bookingId || !ACTIONS.includes(action)) return NextResponse.json({ success: false, error: 'Invalid booking action' }, { status: 400 });
    const { data: booking, error } = await supabase.from('bookings')
      .select('id,reference,status,total_amount,amount_due,payment_method,attention_reason,customers(first_name,last_name,email),tickets(id,ticket_uid,status),payments(method,status)')
      .eq('id', bookingId).maybeSingle();
    if (error) throw error;
    if (!booking) return NextResponse.json({ success: false, error: 'Booking not found' }, { status: 404 });
    const customer = Array.isArray(booking.customers) ? booking.customers[0] : booking.customers;
    const customerEmail = customer?.email || '';
    const customerName = [customer?.first_name, customer?.last_name].filter(Boolean).join(' ') || 'Customer';

    if (action === 'resend_tickets') {
      if (!['PAID', 'CONFIRMED'].includes(booking.status)) return NextResponse.json({ success: false, error: 'Tickets can only be sent for paid bookings' }, { status: 400 });
      if (!booking.tickets?.length) return NextResponse.json({ success: false, error: 'This booking has no tickets to send' }, { status: 400 });
      await generateTicketsAndSendEmail(booking.id, customerEmail, customerName);
      await writeAudit(user.id, 'RESEND_TICKETS', 'booking', booking.id, { reference: booking.reference });
      return NextResponse.json({ success: true, message: 'Ticket email sent' });
    }

    if (action === 'mark_paid') {
      if (reason.length < 3) return NextResponse.json({ success: false, error: 'Enter a reason for marking this booking as paid, e.g. how and when the money was received.' }, { status: 400 });
      const force = body.force === true;
      if (force && role !== 'ADMIN') return NextResponse.json({ success: false, error: 'Only admins can mark a booking paid when the day is full or its seating is taken.' }, { status: 403 });
      // Money already recorded (e.g. a PayFast payment that arrived after the
      // reservation expired) is not recorded a second time.
      const completedPayment = (booking.payments || []).find(payment => payment.status === 'COMPLETE');
      const result = await setBookingPaymentStatus(booking.id, 'PAID', {
        paymentMethod: completedPayment ? booking.payment_method || completedPayment.method : 'ADMIN_OVERRIDE',
        force,
        payment: completedPayment ? undefined : { amount: Number(booking.amount_due ?? booking.total_amount), reference: `ADMIN-${booking.id}` },
      });
      if (!result.ok) {
        const forceable = Boolean(result.reason && FORCEABLE_FAILURES.has(result.reason));
        return NextResponse.json({
          success: false,
          error: forceable ? `${result.detail} ${role === 'ADMIN' ? 'You can still mark it paid if you accept this.' : 'Ask an admin to mark it paid.'}` : result.detail || 'The booking could not be marked paid.',
          capacityExceeded: forceable,
          canForce: forceable && role === 'ADMIN',
        }, { status: 409 });
      }
      let emailSent = true;
      try {
        await generateTicketsAndSendEmail(booking.id, customerEmail, customerName);
      } catch (emailError) {
        emailSent = false;
        console.error(`Ticket email failed after marking ${booking.reference} paid`, emailError);
        await recordNotificationFailure('booking', 'TICKETS_EMAIL_FAILED', customerEmail, booking.id, emailError);
      }
      await writeAudit(user.id, 'MARK_PAID', 'booking', booking.id, { reference: booking.reference, reason, force, previous_status: result.previousStatus, hold_reclaimed: result.reclaimed });
      return NextResponse.json({ success: true, emailSent, message: emailSent ? 'Booking marked paid and tickets issued' : 'Booking marked paid, but the ticket email could not be sent. Use "Resend tickets".' });
    }

    if (action === 'cancel_ticket') {
      if (!ticketId || !booking.tickets?.some(ticket => ticket.id === ticketId)) return NextResponse.json({ success: false, error: 'Ticket not found for this booking' }, { status: 404 });
      const { error: ticketError } = await supabase.from('tickets').update({ status: 'CANCELLED' }).eq('id', ticketId).eq('booking_id', booking.id).eq('status', 'VALID');
      if (ticketError) throw ticketError;
      await writeAudit(user.id, 'CANCEL_TICKET', 'ticket', ticketId, { booking_id: booking.id, reference: booking.reference, reason: reason || null });
      return NextResponse.json({ success: true, message: 'Ticket cancelled and invalidated' });
    }

    if (action === 'resolve_attention') {
      if (!booking.attention_reason) return NextResponse.json({ success: false, error: 'This booking has no open alert.' }, { status: 400 });
      if (reason.length < 3) return NextResponse.json({ success: false, error: 'Describe what was done, e.g. "Refunded in PayFast".' }, { status: 400 });
      const { error: resolveError } = await supabase.from('bookings').update({ attention_reason: null, attention_at: null }).eq('id', booking.id);
      if (resolveError) throw resolveError;
      await writeAudit(user.id, 'RESOLVE_BOOKING_ALERT', 'booking', booking.id, { reference: booking.reference, alert: booking.attention_reason, resolution: reason });
      return NextResponse.json({ success: true, message: 'Alert marked as resolved' });
    }

    // action === 'delete': a soft delete. The booking is cancelled and hidden,
    // but its payments, proofs and history stay for the records.
    if (role !== 'ADMIN') return NextResponse.json({ success: false, error: 'Only admins can delete bookings' }, { status: 403 });
    if (reason.length < 3) return NextResponse.json({ success: false, error: 'Enter a reason for deleting this booking.' }, { status: 400 });
    const result = await archiveBooking(booking.id, user.id, reason);
    if (!result.ok) return NextResponse.json({ success: false, error: result.detail || 'The booking could not be deleted' }, { status: 409 });
    await writeAudit(user.id, 'DELETE_BOOKING', 'booking', booking.id, { reference: booking.reference, reason, previous_status: result.previousStatus });
    return NextResponse.json({ success: true, message: 'Booking deleted. Its payment records and history are kept.' });
  } catch (error) {
    if (error instanceof AdminAuthError) return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    console.error('Admin booking action error', error);
    const message = error instanceof Error && error.message.includes('supabase/migrations/') ? error.message : 'Could not process booking action';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
