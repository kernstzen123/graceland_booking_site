import crypto from 'crypto';
import { NextResponse } from 'next/server';
import { AdminAuthError, requireAdmin, writeAudit } from '@/lib/admin-auth';
import { supabase } from '@/lib/supabase';
import { BOOKABLE_ITEMS, calculateServerTotal } from '@/lib/pricing';
import { getCurrentPrices } from '@/lib/price-store';
import { johannesburgToday } from '@/lib/opening-rules';
import { cleanText, isValidEmail } from '@/lib/request-security';
import { generateTicketsAndSendEmail } from '@/lib/ticketing';
import { recordNotificationFailure } from '@/lib/voucher-email';
import { GATE_PAYMENT_METHODS, GATE_PAYMENT_LABELS, type GatePaymentKey, type WalkInReceipt } from '@/lib/walk-ins';

const STAFF_ROLES = ['ADMIN', 'MANAGER', 'SCANNER'] as const;
// Postgres/PostgREST "column does not exist": the walk-in migration has not been applied.
const MISSING_COLUMN = new Set(['42703', 'PGRST204']);
const MIGRATION_HINT = 'Walk-in sales need the latest database migration (supabase/migrations/20260925_walk_in_sales.sql).';

class SaleError extends Error {}

function one<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] || null : value || null;
}

async function staffNames(ids: string[]) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map<string, string>();
  const { data } = await supabase.from('admin_roles').select('id,display_name').in('id', unique);
  const names = new Map((data || []).map(row => [row.id as string, String(row.display_name || '')]));
  for (const id of unique) {
    if (names.get(id)) continue;
    const { data: user } = await supabase.auth.admin.getUserById(id);
    names.set(id, user.user?.email || 'Staff member');
  }
  return names;
}

/** Everything needed to show or reprint a walk-in receipt. */
async function loadReceipt(bookingId: string, extras: Partial<Pick<WalkInReceipt, 'amountTendered' | 'change' | 'emailSent'>> = {}): Promise<WalkInReceipt> {
  const { data: booking, error } = await supabase
    .from('bookings')
    .select('id,reference,created_at,visit_date,total_amount,people_count,payment_method,sold_by,customers(first_name,last_name),booking_items(quantity,price_per_unit,subtotal,metadata),payments(provider_reference,status),tickets(ticket_uid,qr_token,status),booking_spots(venue_spots(number,type))')
    .eq('id', bookingId)
    .single();
  if (error || !booking) throw error || new Error('Walk-in sale not found');
  const customer = one(booking.customers);
  const tickets = booking.tickets || [];
  const names = await staffNames([booking.sold_by as string]);
  const payment = (booking.payments || []).find(row => row.status === 'COMPLETE');
  return {
    bookingId: booking.id,
    reference: booking.reference,
    createdAt: booking.created_at,
    visitDate: booking.visit_date,
    lines: (booking.booking_items || []).map(item => ({ name: String(item.metadata?.name || 'Item'), quantity: Number(item.quantity), unitPrice: Number(item.price_per_unit), subtotal: Number(item.subtotal) })),
    total: Number(booking.total_amount),
    people: Number(booking.people_count),
    paymentMethod: GATE_PAYMENT_LABELS[booking.payment_method || ''] || booking.payment_method || '',
    paymentReference: payment?.provider_reference && !String(payment.provider_reference).startsWith('GATE-') ? String(payment.provider_reference) : '',
    amountTendered: extras.amountTendered ?? null,
    change: extras.change ?? null,
    seating: (booking.booking_spots || []).map(row => one(row.venue_spots)).filter(Boolean).map(spot => `${spot!.type === 'table' ? 'Table' : 'Hut'} ${spot!.number}`),
    customerName: [customer?.first_name, customer?.last_name].filter(name => name && name !== 'Walk-in' && name !== 'guest').join(' '),
    checkedIn: tickets.length > 0 && tickets.every(ticket => ticket.status === 'USED'),
    emailSent: extras.emailSent ?? null,
    tickets: tickets.map((ticket, index) => ({ ticketUid: ticket.ticket_uid, qrToken: ticket.qr_token, name: `Entrance ticket ${index + 1} of ${tickets.length}`, status: ticket.status })),
    soldBy: names.get(booking.sold_by as string) || '',
  };
}

function errorResponse(error: unknown, fallback: string) {
  if (error instanceof AdminAuthError) return NextResponse.json({ success: false, error: error.message }, { status: error.status });
  if (error instanceof SaleError) return NextResponse.json({ success: false, error: error.message }, { status: 400 });
  const code = (error as { code?: string })?.code;
  if (code && MISSING_COLUMN.has(code)) return NextResponse.json({ success: false, error: MIGRATION_HINT }, { status: 500 });
  const message = error instanceof Error ? error.message : String((error as { message?: string })?.message || '');
  if (/capacity exceeded/i.test(message)) return NextResponse.json({ success: false, error: message.replace(/^.*?(Capacity exceeded)/i, '$1').replace('Capacity exceeded.', 'The venue is at capacity for today.') }, { status: 409 });
  if (/seating spot/i.test(message)) return NextResponse.json({ success: false, error: message }, { status: 409 });
  console.error(fallback, error);
  return NextResponse.json({ success: false, error: fallback }, { status: 500 });
}

/**
 * GET ?date=YYYY-MM-DD — walk-in sales and cash-up totals for a day (default today).
 * GET ?bookingId=… — one sale's receipt, for reprinting.
 * Gate staff only see their own sales; managers and admins see everyone's.
 */
export async function GET(request: Request) {
  try {
    const { user, role } = await requireAdmin(request, [...STAFF_ROLES]);
    const params = new URL(request.url).searchParams;

    const bookingId = params.get('bookingId');
    if (bookingId) {
      const { data: owner } = await supabase.from('bookings').select('sold_by,payment_method,status,tickets(id)').eq('id', bookingId).maybeSingle();
      if (!owner?.payment_method?.startsWith('GATE_') || (role === 'SCANNER' && owner.sold_by !== user.id)) return NextResponse.json({ success: false, error: 'Walk-in sale not found' }, { status: 404 });
      // A sale can be paid but ticketless if ticket creation failed; issue them now.
      if (owner.status === 'PAID' && !owner.tickets?.length) await generateTicketsAndSendEmail(bookingId, '', '', { sendEmail: false });
      return NextResponse.json({ success: true, receipt: await loadReceipt(bookingId) });
    }

    const requested = params.get('date');
    const date = requested && /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : johannesburgToday();
    let query = supabase
      .from('bookings')
      .select('id,reference,created_at,status,payment_method,total_amount,people_count,sold_by,customers(first_name,last_name),booking_items(quantity,metadata),tickets(status)')
      .eq('visit_date', date)
      .like('payment_method', 'GATE_%')
      .order('created_at', { ascending: false })
      .limit(1000);
    if (role === 'SCANNER') query = query.eq('sold_by', user.id);
    const { data, error } = await query;
    if (error) throw error;
    const rows = data || [];
    const names = await staffNames(rows.map(row => row.sold_by as string));

    const paid = rows.filter(row => ['PAID', 'CONFIRMED'].includes(row.status));
    const byMethod = Object.values(GATE_PAYMENT_METHODS).map(method => {
      const matches = paid.filter(row => row.payment_method === method.code);
      return { method: method.label, sales: matches.length, amount: matches.reduce((sum, row) => sum + Number(row.total_amount), 0) };
    });
    const staff = new Map<string, { name: string; sales: number; amount: number; cash: number; people: number }>();
    for (const row of paid) {
      const id = String(row.sold_by || 'unknown');
      const entry = staff.get(id) || { name: names.get(id) || 'Unknown', sales: 0, amount: 0, cash: 0, people: 0 };
      entry.sales += 1; entry.amount += Number(row.total_amount); entry.people += Number(row.people_count || 0);
      if (row.payment_method === GATE_PAYMENT_METHODS.CASH.code) entry.cash += Number(row.total_amount);
      staff.set(id, entry);
    }

    return NextResponse.json({
      success: true,
      date,
      ownSalesOnly: role === 'SCANNER',
      totals: {
        sales: paid.length,
        amount: paid.reduce((sum, row) => sum + Number(row.total_amount), 0),
        people: paid.reduce((sum, row) => sum + Number(row.people_count || 0), 0),
        cancelled: rows.length - paid.length,
      },
      byMethod,
      byStaff: [...staff.values()].sort((a, b) => b.amount - a.amount),
      sales: rows.map(row => {
        const customer = one(row.customers);
        return {
          bookingId: row.id,
          reference: row.reference,
          createdAt: row.created_at,
          status: row.status,
          paymentMethod: GATE_PAYMENT_LABELS[row.payment_method || ''] || row.payment_method,
          total: Number(row.total_amount),
          people: Number(row.people_count || 0),
          soldBy: names.get(String(row.sold_by)) || '',
          customerName: [customer?.first_name, customer?.last_name].filter(name => name && name !== 'Walk-in' && name !== 'guest').join(' '),
          items: (row.booking_items || []).map(item => `${item.quantity}× ${item.metadata?.name || 'Item'}`).join(', '),
          ticketsScanned: (row.tickets || []).filter(ticket => ticket.status === 'USED').length,
          tickets: (row.tickets || []).filter(ticket => ticket.status !== 'CANCELLED').length,
        };
      }),
    });
  } catch (error) {
    return errorResponse(error, 'Could not load walk-in sales');
  }
}

/**
 * POST — record a walk-in sale for today and issue its tickets.
 * Body: { selections, spotIds?, paymentMethod: CASH|CARD|OTHER, paymentReference?, amountTendered?,
 *         checkIn?: boolean, customer?: { firstName?, lastName?, email?, phone? }, idempotencyKey }
 */
export async function POST(request: Request) {
  let bookingId: string | null = null;
  let completed = false;
  try {
    const { user } = await requireAdmin(request, [...STAFF_ROLES]);
    const body = await request.json();
    const visitDate = johannesburgToday();

    // ── Validate the basket ──
    const selections: Record<string, number> = {};
    if (!body?.selections || typeof body.selections !== 'object' || Array.isArray(body.selections)) throw new SaleError('Add at least one item to the sale.');
    for (const [key, value] of Object.entries(body.selections as Record<string, unknown>)) {
      const qty = Number(value);
      if (!Number.isInteger(qty) || qty < 0 || qty > 500) throw new SaleError('Quantities must be whole numbers.');
      if (qty === 0) continue;
      if (!BOOKABLE_ITEMS[key]) throw new SaleError(`Unknown item: ${key}`);
      selections[key] = qty;
    }
    const people = Object.entries(selections).reduce((sum, [key, qty]) => sum + (BOOKABLE_ITEMS[key].isPerson ? qty : 0), 0);
    if (people === 0) throw new SaleError('Add at least one entrance ticket.');

    const spotIds = Array.isArray(body.spotIds) ? body.spotIds.filter((id: unknown): id is string => typeof id === 'string') : [];
    const huts = selections['hut-covered'] || 0;
    const tables = selections['hut-shaded'] || 0;
    if (huts + tables !== spotIds.length) throw new SaleError(`Choose ${huts + tables} seating spot${huts + tables === 1 ? '' : 's'} for the huts and tables in this sale.`);
    if (spotIds.length) {
      const { data: spots, error: spotError } = await supabase.from('venue_spots').select('id,type').in('id', spotIds);
      if (spotError) throw spotError;
      if ((spots || []).length !== spotIds.length) throw new SaleError('One of the seating spots is invalid.');
      if ((spots || []).filter(spot => spot.type === 'hut').length !== huts || (spots || []).filter(spot => spot.type === 'table').length !== tables) throw new SaleError('The chosen seating does not match the huts and tables in the sale.');
    }

    const methodKey = String(body.paymentMethod || '').toUpperCase() as GatePaymentKey;
    const method = GATE_PAYMENT_METHODS[methodKey];
    if (!method) throw new SaleError('Choose how the customer paid.');
    const paymentReference = cleanText(String(body.paymentReference || ''), 80);

    const firstName = cleanText(String(body.customer?.firstName || ''), 80) || 'Walk-in';
    const lastName = cleanText(String(body.customer?.lastName || ''), 80) || 'guest';
    const email = cleanText(String(body.customer?.email || ''), 254).toLowerCase();
    const phone = cleanText(String(body.customer?.phone || ''), 40);
    if (email && !isValidEmail(email)) throw new SaleError('The email address is not valid. Leave it empty if the customer does not want tickets emailed.');

    const prices = await getCurrentPrices();
    const { lineItems, total } = calculateServerTotal(selections, undefined, prices);
    const tendered = body.amountTendered === undefined || body.amountTendered === null || body.amountTendered === '' ? null : Number(body.amountTendered);
    if (methodKey === 'CASH' && tendered !== null && (!Number.isFinite(tendered) || tendered < total)) throw new SaleError(`Cash received must be at least R ${total.toFixed(2)}.`);
    if (body.expectedTotal !== undefined && Math.abs(Number(body.expectedTotal) - total) > 0.01) throw new SaleError('Prices have changed since this screen was opened. Refresh the page and check the total with the customer.');

    const idempotencyKey = typeof body.idempotencyKey === 'string' && body.idempotencyKey.trim() ? `walkin-${body.idempotencyKey.trim().slice(0, 80)}` : null;
    if (idempotencyKey) {
      const { data: existing } = await supabase.from('bookings').select('id,status').eq('idempotency_key', idempotencyKey).maybeSingle();
      if (existing?.status === 'PAID') return NextResponse.json({ success: true, receipt: await loadReceipt(existing.id) });
      if (existing) throw new SaleError('This sale is still being processed. Wait a moment and check the sales list before trying again.');
    }

    // ── Reserve capacity (same database lock as online bookings) ──
    const reference = `WI-${visitDate.slice(0, 4)}-${crypto.randomBytes(5).toString('base64url').replace(/[_-]/g, '').slice(0, 8).toUpperCase().padEnd(8, '0')}`;
    const { data: newBookingId, error: reserveError } = await supabase.rpc('reserve_capacity', {
      p_visit_date: visitDate,
      p_people_count: people,
      p_customer: { firstName, lastName, email, phone },
      p_reference: reference,
      p_total_amount: total,
      p_party_slot: null,
      p_idempotency_key: idempotencyKey,
      p_voucher_code: null,
    });
    if (reserveError) throw reserveError;
    bookingId = newBookingId as string;

    const { error: itemsError } = await supabase.from('booking_items').insert(lineItems.map(line => ({
      booking_id: bookingId, quantity: line.quantity, price_per_unit: line.pricePerUnit, subtotal: line.subtotal,
      metadata: { itemId: line.itemId, name: line.name, isPerson: line.isPerson, walkIn: true },
    })));
    if (itemsError) throw itemsError;
    if (spotIds.length) {
      const { error: spotsError } = await supabase.rpc('reserve_booking_spots', { p_booking_id: bookingId, p_visit_date: visitDate, p_spot_ids: spotIds });
      if (spotsError) throw spotsError;
    }

    // ── Take payment ──
    const { error: paidError } = await supabase.from('bookings').update({
      status: 'PAID', payment_method: method.code, amount_due: total, expires_at: null, sold_by: user.id, notes: 'WALK_IN',
    }).eq('id', bookingId);
    if (paidError) throw paidError;
    const { error: paymentError } = await supabase.from('payments').insert({
      booking_id: bookingId, amount: total, method: method.code, status: 'COMPLETE', provider_reference: paymentReference || `GATE-${reference}`,
    });
    if (paymentError) throw paymentError;
    completed = true;

    // ── Tickets ──
    const customerName = `${firstName} ${lastName}`.trim();
    let emailSent: boolean | null = null;
    await generateTicketsAndSendEmail(bookingId, email, customerName, { sendEmail: false });
    if (email) {
      try {
        await generateTicketsAndSendEmail(bookingId, email, customerName);
        emailSent = true;
      } catch (emailError) {
        emailSent = false;
        await recordNotificationFailure('booking', 'WALK_IN_TICKETS', email, bookingId, emailError);
      }
    }
    if (body.checkIn !== false) {
      const { data: used, error: checkInError } = await supabase.from('tickets').update({ status: 'USED' }).eq('booking_id', bookingId).eq('status', 'VALID').select('id');
      if (checkInError) throw checkInError;
      if (used?.length) {
        const { error: scanError } = await supabase.from('ticket_scans').insert(used.map(ticket => ({ ticket_id: ticket.id, scanned_by: user.id, result_status: 'APPROVED' })));
        if (scanError) console.error('Could not record walk-in check-in scans', scanError);
      }
    }

    await writeAudit(user.id, 'WALK_IN_SALE', 'booking', bookingId, {
      reference, total, people, payment_method: method.code, payment_reference: paymentReference || null,
      amount_tendered: tendered, checked_in: body.checkIn !== false, seating: spotIds.length,
    });
    const receipt = await loadReceipt(bookingId, {
      amountTendered: methodKey === 'CASH' ? tendered : null,
      change: methodKey === 'CASH' && tendered !== null ? Math.round((tendered - total) * 100) / 100 : null,
      emailSent,
    });
    return NextResponse.json({ success: true, receipt });
  } catch (error) {
    // Nothing was paid yet: remove the half-made booking so it does not hold capacity or seating.
    if (bookingId && !completed) {
      const { error: cleanupError } = await supabase.from('bookings').delete().eq('id', bookingId);
      if (cleanupError) console.error('Could not remove incomplete walk-in booking', bookingId, cleanupError);
    }
    return errorResponse(error, completed ? 'The sale was recorded but tickets could not be issued. Find it in the sales list below and reprint.' : 'Could not record the walk-in sale');
  }
}
