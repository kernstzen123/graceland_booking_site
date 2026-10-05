import { NextResponse } from 'next/server';
import { AdminAuthError, requireAdmin, writeAudit } from '@/lib/admin-auth';
import { supabase } from '@/lib/supabase';
import { emailTicketsOnce, generateTicketsAndSendEmail } from '@/lib/ticketing';
import { recordNotificationFailure } from '@/lib/voucher-email';
import { archiveBooking, FORCEABLE_FAILURES, setBookingPaymentStatus } from '@/lib/booking-holds';

const DETAIL_FIELDS = 'id,reference,visit_date,status,payment_method,total_amount,people_count,created_at,expires_at,notes,refunded_at,voucher_issued,voucher_amount_used,amount_due,deleted_at,delete_reason,attention_reason,attention_at,customers(first_name,last_name,email,phone),booking_items(id,quantity,price_per_unit,subtotal,metadata,packages(name),huts(name)),payments(id,amount,method,status,provider_reference,created_at),payment_proofs(id,file_url,status,admin_notes,uploaded_at,verified_at),tickets(id,ticket_uid,qr_token,status,visit_date,issued_at)';
const STATUS_FILTERS = ['PAID', 'PENDING', 'CANCELLED', 'FAILED', 'ATTENTION', 'DELETED'];
const ACTIONS = ['resend_tickets', 'delete', 'purge', 'update', 'mark_paid', 'cancel_ticket', 'resolve_attention'];
const isImportedBooking = (booking: { reference?: string | null; payment_method?: string | null }) => String(booking.reference || '').toUpperCase().startsWith('IM-') || booking.payment_method === 'IMPORTED';
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
      .select('id,reference,status,total_amount,amount_due,payment_method,attention_reason,visit_date,customer_id,notes,people_count,voucher_amount_used,customers(first_name,last_name,email),tickets(id,ticket_uid,status),payments(method,status)')
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
        await emailTicketsOnce(booking.id, customerEmail, customerName);
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

    if (action === 'update') {
      if (!isImportedBooking(booking)) return NextResponse.json({ success: false, error: 'Only imported (IM-) bookings can be edited this way.' }, { status: 400 });
      const text = (value: unknown, max: number) => (typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');
      const edit = body.edit || {};
      const updates: Record<string, unknown> = {};

      // Visit date
      let visitDate = booking.visit_date as string;
      if (edit.visit_date !== undefined) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(edit.visit_date))) return NextResponse.json({ success: false, error: 'Enter a valid visit date.' }, { status: 400 });
        visitDate = String(edit.visit_date);
        updates.visit_date = visitDate;
      }

      // Items
      let itemsChanged = false;
      let derivedTotal: number | null = null;
      let derivedPeople: number | null = null;
      if (Array.isArray(edit.items)) {
        const { data: existingItems, error: itemsError } = await supabase.from('booking_items').select('id,metadata').eq('booking_id', booking.id);
        if (itemsError) throw itemsError;
        const existingById = new Map((existingItems || []).map(item => [item.id, item]));
        const clean: Array<{ id?: string; name: string; quantity: number; price: number; isPerson: boolean }> = [];
        for (const raw of edit.items.slice(0, 60)) {
          const quantity = Number(raw?.quantity); const price = Number(raw?.price_per_unit);
          const name = text(raw?.name, 120);
          if (!name) return NextResponse.json({ success: false, error: 'Every item needs a name.' }, { status: 400 });
          if (!Number.isInteger(quantity) || quantity < 1 || quantity > 500) return NextResponse.json({ success: false, error: `Quantity for "${name}" must be a whole number from 1 to 500.` }, { status: 400 });
          if (!Number.isFinite(price) || price < 0 || price > 1000000) return NextResponse.json({ success: false, error: `Price for "${name}" is not valid.` }, { status: 400 });
          if (raw.id && !existingById.has(raw.id)) return NextResponse.json({ success: false, error: 'An item does not belong to this booking.' }, { status: 400 });
          clean.push({ id: raw.id, name, quantity, price: Math.round(price * 100) / 100, isPerson: raw.isPerson === true });
        }
        if (!clean.length) return NextResponse.json({ success: false, error: 'A booking needs at least one item.' }, { status: 400 });
        const keepIds = new Set(clean.filter(item => item.id).map(item => item.id as string));
        const removeIds = (existingItems || []).map(item => item.id).filter(itemId => !keepIds.has(itemId));
        if (removeIds.length) {
          const { error: removeError } = await supabase.from('booking_items').delete().in('id', removeIds);
          if (removeError) throw removeError;
        }
        for (const item of clean) {
          const subtotal = Math.round(item.price * item.quantity * 100) / 100;
          if (item.id) {
            const previous = (existingById.get(item.id)?.metadata || {}) as Record<string, unknown>;
            const { error: updateItemError } = await supabase.from('booking_items').update({ quantity: item.quantity, price_per_unit: item.price, subtotal, metadata: { ...previous, name: item.name, isPerson: item.isPerson } }).eq('id', item.id);
            if (updateItemError) throw updateItemError;
          } else {
            const { error: insertItemError } = await supabase.from('booking_items').insert({ booking_id: booking.id, quantity: item.quantity, price_per_unit: item.price, subtotal, metadata: { name: item.name, isPerson: item.isPerson } });
            if (insertItemError) throw insertItemError;
          }
        }
        itemsChanged = true;
        derivedTotal = clean.reduce((sum, item) => sum + item.price * item.quantity, 0);
        derivedPeople = clean.reduce((sum, item) => sum + (item.isPerson ? item.quantity : 0), 0);
      }

      // Totals
      if (edit.total_amount !== undefined && edit.total_amount !== null && edit.total_amount !== '') {
        const total = Number(edit.total_amount);
        if (!Number.isFinite(total) || total < 0 || total > 10000000) return NextResponse.json({ success: false, error: 'The total is not valid.' }, { status: 400 });
        updates.total_amount = Math.round(total * 100) / 100;
      } else if (derivedTotal !== null) updates.total_amount = Math.round(derivedTotal * 100) / 100;
      if (edit.people_count !== undefined && edit.people_count !== null && edit.people_count !== '') {
        const people = Number(edit.people_count);
        if (!Number.isInteger(people) || people < 1 || people > 5000) return NextResponse.json({ success: false, error: 'People must be a whole number of at least 1.' }, { status: 400 });
        updates.people_count = people;
      } else if (derivedPeople) updates.people_count = derivedPeople;

      // Notes keep the system marker line so the booking stays recognisable as imported.
      if (edit.notes !== undefined) {
        const staffNote = text(edit.notes, 500);
        updates.notes = staffNote ? `IMPORTED_FROM_BOOK\n${staffNote}` : 'IMPORTED_FROM_BOOK';
      }

      // Customer: a fresh customer row, so no other booking sharing the old one is changed.
      let newCustomerId: string | null = null;
      if (edit.customer) {
        const firstName = text(edit.customer.first_name, 80); const lastName = text(edit.customer.last_name, 80);
        const email = text(edit.customer.email, 254).toLowerCase(); const phone = text(edit.customer.phone, 40);
        if (!firstName || !lastName) return NextResponse.json({ success: false, error: 'Enter the customer\'s first name and surname.' }, { status: 400 });
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return NextResponse.json({ success: false, error: `"${email}" is not a valid email address.` }, { status: 400 });
        const { data: newCustomer, error: customerInsertError } = await supabase.from('customers').insert({ first_name: firstName, last_name: lastName, email, phone }).select('id').single();
        if (customerInsertError) throw customerInsertError;
        newCustomerId = newCustomer.id;
        updates.customer_id = newCustomerId;
      }

      if (Object.keys(updates).length) {
        const { error: bookingUpdateError } = await supabase.from('bookings').update(updates).eq('id', booking.id);
        if (bookingUpdateError) throw bookingUpdateError;
      }
      if (newCustomerId) await supabase.from('tickets').update({ customer_id: newCustomerId }).eq('booking_id', booking.id);
      if (edit.visit_date !== undefined && visitDate !== booking.visit_date) {
        await supabase.from('tickets').update({ visit_date: visitDate }).eq('booking_id', booking.id);
        await supabase.from('booking_spots').update({ visit_date: visitDate }).eq('booking_id', booking.id);
        await supabase.from('meal_vouchers').update({ visit_date: visitDate }).eq('booking_id', booking.id);
      }

      // Gate tickets follow the items. Tickets that were already scanned are never touched.
      let ticketNote = '';
      if (itemsChanged) {
        const hasUsed = (booking.tickets || []).some(ticket => ticket.status === 'USED');
        if (hasUsed) ticketNote = ' Some tickets were already scanned, so the tickets were left as they are.';
        else {
          const { error: clearError } = await supabase.from('tickets').delete().eq('booking_id', booking.id);
          if (clearError) throw clearError;
          const finalCustomer = newCustomerId ? edit.customer : customer;
          const name = [finalCustomer?.first_name, finalCustomer?.last_name].filter(Boolean).join(' ') || 'Customer';
          try { await generateTicketsAndSendEmail(booking.id, finalCustomer?.email || '', name, { sendEmail: false }); }
          catch (ticketError) { console.error('Could not rebuild tickets after editing', booking.reference, ticketError); ticketNote = ' The tickets could not be rebuilt: make sure at least one item is marked as a person.'; }
        }
      }
      await writeAudit(user.id, 'EDIT_IMPORTED_BOOKING', 'booking', booking.id, { reference: booking.reference, fields: Object.keys(updates), items_changed: itemsChanged });
      return NextResponse.json({ success: true, message: `Booking updated.${ticketNote}` });
    }

    if (action === 'purge') {
      // Permanent deletion: the booking and everything attached to it are removed for good.
      if (role !== 'ADMIN') return NextResponse.json({ success: false, error: 'Only admins can permanently delete bookings.' }, { status: 403 });
      if (reason.length < 3) return NextResponse.json({ success: false, error: 'Enter a reason for permanently deleting this booking.' }, { status: 400 });
      const { data: issuedCredits } = await supabase.from('booking_credits').select('id').eq('original_booking_id', booking.id).limit(1);
      if (issuedCredits?.length) return NextResponse.json({ success: false, error: 'A voucher was issued from this booking, so it cannot be permanently deleted. Use Delete instead, which keeps the records.' }, { status: 409 });

      // Give back any voucher balance this booking was still holding.
      const { data: redemptions } = await supabase.from('credit_redemptions').select('id,credit_id,amount_used,released').eq('booking_id', booking.id);
      for (const redemption of redemptions || []) {
        if (redemption.released) continue;
        const { data: credit } = await supabase.from('booking_credits').select('remaining_balance,status').eq('id', redemption.credit_id).maybeSingle();
        if (credit && credit.status !== 'void') await supabase.from('booking_credits').update({ remaining_balance: Number(credit.remaining_balance) + Number(redemption.amount_used), status: 'active' }).eq('id', redemption.credit_id);
      }

      const { data: proofs } = await supabase.from('payment_proofs').select('file_url').eq('booking_id', booking.id);
      const removals: Array<[string, string]> = [['credit_redemptions', 'booking_id'], ['meal_redemptions', 'booking_id'], ['meal_vouchers', 'booking_id'], ['booking_specials', 'booking_id'], ['tickets', 'booking_id'], ['booking_spots', 'booking_id'], ['booking_items', 'booking_id'], ['payment_proofs', 'booking_id'], ['payments', 'booking_id']];
      for (const [table, column] of removals) {
        const { error: removeError } = await supabase.from(table).delete().eq(column, booking.id);
        if (removeError && !['42P01', 'PGRST205'].includes(removeError.code || '')) throw removeError;
      }
      const { error: bookingDeleteError } = await supabase.from('bookings').delete().eq('id', booking.id);
      if (bookingDeleteError) throw bookingDeleteError;
      const proofPaths = (proofs || []).map(proof => proof.file_url).filter((path): path is string => typeof path === 'string' && !path.startsWith('http'));
      if (proofPaths.length) await supabase.storage.from('payment-proofs').remove(proofPaths).catch(() => undefined);
      await writeAudit(user.id, 'PURGE_BOOKING', 'booking', booking.id, { reference: booking.reference, reason, status: booking.status, total_amount: booking.total_amount });
      return NextResponse.json({ success: true, message: `Booking ${booking.reference} was permanently deleted.` });
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
