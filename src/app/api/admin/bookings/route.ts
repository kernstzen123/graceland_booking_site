import { NextResponse } from 'next/server';
import { AdminAuthError, requireAdmin, writeAudit } from '@/lib/admin-auth';
import { supabase } from '@/lib/supabase';
import { emailTicketsOnce, generateTicketsAndSendEmail, resignBookingQrCodes } from '@/lib/ticketing';
import { recordNotificationFailure } from '@/lib/voucher-email';
import { archiveBooking, FORCEABLE_FAILURES, setBookingPaymentStatus } from '@/lib/booking-holds';
import { BookingEditError, linesChanged, parseEditedItems, seatsNeeded, type StoredLine } from '@/lib/booking-edit';
import { spotLabel } from '@/lib/seating';

const DETAIL_FIELDS = 'id,reference,visit_date,status,payment_method,total_amount,people_count,created_at,expires_at,notes,refunded_at,voucher_issued,voucher_amount_used,amount_due,deleted_at,delete_reason,attention_reason,attention_at,customers(first_name,last_name,email,phone),booking_items(id,quantity,price_per_unit,subtotal,metadata,packages(name),huts(name)),booking_spots(spot_id,venue_spots(number,type)),payments(id,amount,method,status,provider_reference,created_at),payment_proofs(id,file_url,status,admin_notes,uploaded_at,verified_at),tickets(id,ticket_uid,qr_token,status,visit_date,issued_at)';
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
      .select('id,reference,status,total_amount,amount_due,payment_method,attention_reason,visit_date,customer_id,notes,people_count,voucher_amount_used,party_slot,customers(first_name,last_name,email,phone),tickets(id,ticket_uid,status),payments(method,status),booking_spots(spot_id,venue_spots(number,type))')
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
      const fail = (message: string, status = 400) => NextResponse.json({ success: false, error: message }, { status });

      // ── Check everything first; nothing is saved until all of it is valid ──
      let visitDate = booking.visit_date as string;
      if (edit.visit_date !== undefined) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(edit.visit_date))) return fail('Enter a valid visit date.');
        visitDate = String(edit.visit_date);
        if (visitDate !== booking.visit_date) updates.visit_date = visitDate;
      }
      const dateChanged = visitDate !== booking.visit_date;

      // Items: chosen from the price list (see EDITABLE_ITEMS), so names, ticket codes and the
      // party/person flags match online bookings and are counted the same everywhere.
      const { data: storedItems, error: itemsError } = await supabase.from('booking_items').select('id,quantity,price_per_unit,metadata').eq('booking_id', booking.id);
      if (itemsError) throw itemsError;
      const existingLines = (storedItems || []) as StoredLine[];
      let lines;
      try { lines = Array.isArray(edit.items) ? parseEditedItems(edit.items, existingLines, booking.party_slot || null) : null; }
      catch (editError) { if (editError instanceof BookingEditError) return fail(editError.message); throw editError; }
      const itemsChanged = lines ? linesChanged(lines, existingLines) : false;

      // Seating: spots picked from the map (current spots only), one per hut or table on the booking.
      const currentSpotIds = (booking.booking_spots || []).map(row => row.spot_id as string);
      let spotIds = currentSpotIds;
      if (edit.spot_ids !== undefined) {
        if (!Array.isArray(edit.spot_ids) || edit.spot_ids.some((spotId: unknown) => typeof spotId !== 'string')) return fail('The seating is not valid.');
        spotIds = [...new Set(edit.spot_ids as string[])];
        if (spotIds.length !== edit.spot_ids.length) return fail('The same hut or table was chosen twice.');
      }
      const seatsChanged = spotIds.length !== currentSpotIds.length || spotIds.some(spotId => !currentSpotIds.includes(spotId));
      let chosenSpots: Array<{ id: string; type: string; number: string }> = [];
      if (spotIds.length) {
        const { data: spotRows, error: spotError } = await supabase.from('venue_spots').select('id,type,number,active').in('id', spotIds);
        if (spotError) throw spotError;
        chosenSpots = (spotRows || []) as typeof chosenSpots;
        if (chosenSpots.length !== spotIds.length) return fail('One of the huts or tables does not exist.');
        if (seatsChanged && (spotRows || []).some(spot => !spot.active)) return fail('Choose huts and tables from the current map.');
      }
      // When the items or seats change, the seats must match the huts and tables on the booking.
      if ((itemsChanged || seatsChanged) && lines) {
        const need = seatsNeeded(lines);
        const huts = chosenSpots.filter(spot => spot.type === 'hut').length;
        const tables = chosenSpots.filter(spot => spot.type === 'table').length;
        if (huts !== need.huts || tables !== need.tables) {
          const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
          return fail(`The items need ${plural(need.huts, 'hut')} and ${plural(need.tables, 'table')}${lines.some(line => line.item?.id.startsWith('party-children-')) ? ' (a party includes one hut)' : ''}, but ${plural(huts, 'hut')} and ${plural(tables, 'table')} ${huts + tables === 1 ? 'is' : 'are'} chosen.`);
        }
      }

      if (edit.total_amount !== undefined && edit.total_amount !== null && edit.total_amount !== '') {
        const total = Number(edit.total_amount);
        if (!Number.isFinite(total) || total < 0 || total > 10000000) return fail('The total is not valid.');
        updates.total_amount = Math.round(total * 100) / 100;
      } else if (lines && itemsChanged) updates.total_amount = Math.round(lines.reduce((sum, line) => sum + line.price * line.quantity, 0) * 100) / 100;
      if (edit.people_count !== undefined && edit.people_count !== null && edit.people_count !== '') {
        const people = Number(edit.people_count);
        if (!Number.isInteger(people) || people < 1 || people > 5000) return fail('People must be a whole number of at least 1.');
        updates.people_count = people;
      } else if (lines && itemsChanged) updates.people_count = lines.reduce((sum, line) => sum + (line.isPerson ? line.quantity : 0), 0);
      for (const key of ['total_amount', 'people_count'] as const) if (updates[key] !== undefined && Number(updates[key]) === Number(booking[key])) delete updates[key];

      // Notes keep the system marker line so the booking stays recognisable as imported.
      if (edit.notes !== undefined) {
        const staffNote = text(edit.notes, 500);
        const notes = staffNote ? `IMPORTED_FROM_BOOK\n${staffNote}` : 'IMPORTED_FROM_BOOK';
        if (notes !== booking.notes) updates.notes = notes;
      }

      // Customer: only when something changed, as a fresh customer row so no other booking sharing the old one is changed.
      let newCustomer: { first_name: string; last_name: string; email: string; phone: string } | null = null;
      if (edit.customer) {
        const next = { first_name: text(edit.customer.first_name, 80), last_name: text(edit.customer.last_name, 80), email: text(edit.customer.email, 254).toLowerCase(), phone: text(edit.customer.phone, 40) };
        if (!next.first_name || !next.last_name) return fail('Enter the customer\'s first name and surname.');
        if (next.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.email)) return fail(`"${next.email}" is not a valid email address.`);
        const before = customer as { first_name?: string; last_name?: string; email?: string; phone?: string } | null;
        if (next.first_name !== (before?.first_name || '') || next.last_name !== (before?.last_name || '') || next.email !== (before?.email || '') || next.phone !== (before?.phone || '')) newCustomer = next;
      }

      // ── Save ──
      // Seats first: the database swaps them in one step, checks clashes (party huts by time
      // slot) under the seating lock, and refuses a taken spot, leaving the booking untouched.
      const seatsMoved = seatsChanged || (dateChanged && spotIds.length > 0);
      if (seatsMoved) {
        if (spotIds.length) {
          const { error: reserveError } = await supabase.rpc('reserve_booking_spots', { p_booking_id: booking.id, p_visit_date: visitDate, p_spot_ids: spotIds });
          if (reserveError) {
            if (/just taken|invalid|more than once/i.test(reserveError.message)) return fail(`${reserveError.message.replace('Please choose another spot.', '')}Choose another hut or table${dateChanged ? ` for ${visitDate}` : ''}.`, 409);
            throw reserveError;
          }
        } else {
          const { error: clearSpotsError } = await supabase.from('booking_spots').delete().eq('booking_id', booking.id);
          if (clearSpotsError) throw clearSpotsError;
        }
      }

      if (lines && itemsChanged) {
        const keepIds = new Set(lines.filter(line => line.id).map(line => line.id as string));
        const removeIds = existingLines.map(line => line.id).filter(lineId => !keepIds.has(lineId));
        if (removeIds.length) {
          const { error: removeError } = await supabase.from('booking_items').delete().in('id', removeIds);
          if (removeError) throw removeError;
        }
        for (const line of lines) {
          const row = { quantity: line.quantity, price_per_unit: line.price, subtotal: Math.round(line.price * line.quantity * 100) / 100, metadata: line.metadata };
          const { error: saveItemError } = line.id
            ? await supabase.from('booking_items').update(row).eq('id', line.id)
            : await supabase.from('booking_items').insert({ booking_id: booking.id, ...row });
          if (saveItemError) throw saveItemError;
        }
      }

      if (newCustomer) {
        const { data: customerRow, error: customerInsertError } = await supabase.from('customers').insert(newCustomer).select('id').single();
        if (customerInsertError) throw customerInsertError;
        updates.customer_id = customerRow.id;
      }
      if (Object.keys(updates).length) {
        const { error: bookingUpdateError } = await supabase.from('bookings').update(updates).eq('id', booking.id);
        if (bookingUpdateError) throw bookingUpdateError;
      }
      if (updates.customer_id) await supabase.from('tickets').update({ customer_id: updates.customer_id }).eq('booking_id', booking.id);
      if (dateChanged) {
        const { error: ticketDateError } = await supabase.from('tickets').update({ visit_date: visitDate }).eq('booking_id', booking.id);
        if (ticketDateError) throw ticketDateError;
        const { error: mealDateError } = await supabase.from('meal_vouchers').update({ visit_date: visitDate }).eq('booking_id', booking.id);
        if (mealDateError) throw mealDateError;
        // QR codes are only valid up to the date they were signed for: re-sign them for the new date.
        await resignBookingQrCodes(booking.id, visitDate);
      }

      // Gate tickets follow the items. Tickets that were already scanned are never touched.
      let ticketNote = '';
      if (itemsChanged) {
        const hasUsed = (booking.tickets || []).some(ticket => ticket.status === 'USED');
        if (hasUsed) ticketNote = ' Some tickets were already scanned, so the tickets were left as they are.';
        else {
          const { error: clearError } = await supabase.from('tickets').delete().eq('booking_id', booking.id);
          if (clearError) throw clearError;
          const finalCustomer = newCustomer || customer;
          const name = [finalCustomer?.first_name, finalCustomer?.last_name].filter(Boolean).join(' ') || 'Customer';
          try { await generateTicketsAndSendEmail(booking.id, finalCustomer?.email || '', name, { sendEmail: false }); }
          catch (ticketError) { console.error('Could not rebuild tickets after editing', booking.reference, ticketError); ticketNote = ' The tickets could not be rebuilt. Try saving again.'; }
        }
      }

      const seatNames = (spots: Array<{ type: string; number: string } | null | undefined>) => spots.filter(Boolean).map(spot => spotLabel(spot!.type, spot!.number)).join(', ') || 'none';
      const describeLines = (rows: Array<{ quantity: number; price: number; name: string }>) => rows.map(row => `${row.quantity}× ${row.name} @ R${row.price}`);
      await writeAudit(user.id, 'EDIT_IMPORTED_BOOKING', 'booking', booking.id, {
        reference: booking.reference,
        fields: Object.keys(updates),
        ...(itemsChanged && lines ? { items: { from: describeLines(existingLines.map(line => ({ quantity: line.quantity, price: Number(line.price_per_unit), name: String(line.metadata?.name || 'Item') }))), to: describeLines(lines) } } : {}),
        ...(seatsMoved ? { seating: { from: seatNames((booking.booking_spots || []).map(row => (Array.isArray(row.venue_spots) ? row.venue_spots[0] : row.venue_spots) as { type: string; number: string } | null)), to: seatNames(chosenSpots) } } : {}),
        ...(dateChanged ? { visit_date: { from: booking.visit_date, to: visitDate } } : {}),
        ...(updates.total_amount !== undefined ? { total_amount: { from: booking.total_amount, to: updates.total_amount } } : {}),
        ...(updates.people_count !== undefined ? { people_count: { from: booking.people_count, to: updates.people_count } } : {}),
      });
      const changed = itemsChanged || seatsMoved || Object.keys(updates).length > 0;
      return NextResponse.json({ success: true, message: changed ? `Booking updated.${ticketNote}` : 'Nothing was changed.' });
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
