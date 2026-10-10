import 'server-only';
import { supabase } from '@/lib/supabase';

/**
 * Booking holds and payment status changes.
 *
 * A booking keeps its places, seats and voucher balance while it is
 * PAYMENT_PENDING, or UNPAID with expires_at in the future. When that hold
 * lapses they are free for other customers, so a late payment or proof upload
 * must win them back first. Every status change that could revive a booking
 * goes through these database functions, which re-check capacity, seating and
 * the voucher under the same locks the booking flow uses.
 */

/** How long a PayFast checkout keeps the booking, counted from when the customer is sent to PayFast. */
export const PAYFAST_HOLD_MINUTES = 15;

/** EFT customers have this long from when the booking was made to pay. No booking is held longer. */
export function eftHoldHours() {
  const hours = Number(process.env.EFT_HOLD_HOURS);
  return Number.isInteger(hours) && hours >= 1 && hours <= 168 ? hours : 48;
}

/**
 * Bookings staff make on the Add booking tab without payment never lapse: they
 * keep their places until an admin or manager deletes them (or they are paid).
 * Only online bookings have a payment window. Stored as a far-future hold so
 * every "is this booking still holding its places" check keeps working.
 */
export const STAFF_HOLD_UNTIL = '9999-12-31T23:59:59.000Z';

/** Whether a hold is the never-ending one staff bookings get. */
export const isOpenEndedHold = (holdUntil: string | null | undefined) => Boolean(holdUntil) && new Date(holdUntil as string).getUTCFullYear() >= 9999;

/** An unpaid booking made by staff (Add booking tab), not by a customer online. */
export const isStaffUnpaidBooking = (booking: { sold_by?: string | null; payment_method?: string | null }) =>
  Boolean(booking.sold_by) || booking.payment_method === 'MANUAL_EFT';

export type HoldFailure =
  | 'NOT_FOUND' | 'CANCELLED' | 'ALREADY_PAID' | 'NOT_PAYABLE' | 'EXPIRED'
  | 'FULL' | 'SEAT_TAKEN' | 'VOUCHER_UNAVAILABLE' | 'DATE_PASSED' | 'DATE_CLOSED';

export type HoldResult = { ok: boolean; reason: HoldFailure | null; detail: string | null; holdUntil: string | null };
export type StatusResult = { ok: boolean; reason: HoldFailure | null; detail: string | null; previousStatus: string | null; reclaimed: boolean };

/** Failures a staff member can override by forcing: the booking would go over capacity, share a seat, or fall on a closed/past date. */
export const FORCEABLE_FAILURES: ReadonlySet<HoldFailure> = new Set(['FULL', 'SEAT_TAKEN', 'DATE_PASSED', 'DATE_CLOSED']);

function firstRow<T>(data: unknown): T | null {
  return ((Array.isArray(data) ? data[0] : data) as T | undefined) ?? null;
}

function rpcError(error: { code?: string; message?: string }) {
  // PGRST202: PostgREST cannot find the function.
  if (error.code === 'PGRST202') return new Error('The database is missing supabase/migrations/20260927_security_hardening.sql. Apply it in Supabase and try again.');
  return error;
}

/**
 * Keep (or win back) the booking's reservation while the customer pays.
 * The hold becomes now + holdMinutes, capped at maxHoldHours after the booking
 * was made, and is never shortened.
 */
export async function holdBookingForPayment(bookingId: string, holdMinutes: number, maxHoldHours = eftHoldHours()): Promise<HoldResult> {
  // A booking staff made without payment has no payment window: resending the EFT email or
  // paying by PayFast must never refuse it as expired, and it keeps its never-ending hold.
  const { data: booking, error: lookupError } = await supabase.from('bookings').select('sold_by,payment_method,created_at').eq('id', bookingId).maybeSingle();
  if (lookupError) throw lookupError;
  const staffBooking = Boolean(booking && isStaffUnpaidBooking(booking));
  if (staffBooking) maxHoldHours = Math.max(maxHoldHours, Math.ceil((Date.now() - new Date(booking?.created_at || Date.now()).getTime()) / 3600000) + eftHoldHours());
  const { data, error } = await supabase.rpc('hold_booking_for_payment', {
    p_booking_id: bookingId,
    p_hold_minutes: holdMinutes,
    p_max_hold_hours: maxHoldHours,
  });
  if (error) throw rpcError(error);
  const row = firstRow<{ ok: boolean; reason: HoldFailure | null; detail: string | null; hold_until: string | null }>(data);
  if (!row) throw new Error('hold_booking_for_payment returned no result');
  // The database kept (or won back, after its capacity and seating checks) the booking's places; make the hold open-ended again.
  if (row.ok && staffBooking && !isOpenEndedHold(row.hold_until)) {
    const { data: updated, error: holdError } = await supabase.from('bookings').update({ expires_at: STAFF_HOLD_UNTIL }).eq('id', bookingId).eq('status', 'UNPAID').select('expires_at');
    if (holdError) throw holdError;
    if (updated?.length) return { ok: true, reason: null, detail: null, holdUntil: STAFF_HOLD_UNTIL };
  }
  return { ok: row.ok, reason: row.reason, detail: row.detail, holdUntil: row.hold_until };
}

/**
 * Move a booking to PAYMENT_PENDING or PAID, reclaiming its hold first if it lapsed.
 * `payment` records a COMPLETE payment in the same transaction.
 * `force` (admins only) accepts going over capacity or sharing a seat.
 */
export async function setBookingPaymentStatus(
  bookingId: string,
  status: 'PAID' | 'PAYMENT_PENDING',
  options: { paymentMethod?: string | null; force?: boolean; payment?: { amount: number; reference: string } } = {},
): Promise<StatusResult> {
  const { data, error } = await supabase.rpc('set_booking_payment_status', {
    p_booking_id: bookingId,
    p_status: status,
    p_payment_method: options.paymentMethod ?? null,
    p_force: options.force === true,
    p_payment_amount: options.payment ? options.payment.amount : null,
    p_payment_reference: options.payment ? options.payment.reference : null,
  });
  if (error) throw rpcError(error);
  const row = firstRow<{ ok: boolean; reason: HoldFailure | null; detail: string | null; previous_status: string | null; reclaimed: boolean }>(data);
  if (!row) throw new Error('set_booking_payment_status returned no result');
  return { ok: row.ok, reason: row.reason, detail: row.detail, previousStatus: row.previous_status, reclaimed: row.reclaimed };
}

/**
 * Soft-delete a booking: it is cancelled and hidden from the bookings list, but
 * its payments, proofs and audit history are kept. Paid bookings and bookings
 * with a proof awaiting review are refused.
 */
export async function archiveBooking(bookingId: string, actorId: string, reason: string) {
  const { data, error } = await supabase.rpc('archive_booking', { p_booking_id: bookingId, p_actor: actorId, p_reason: reason });
  if (error) throw rpcError(error);
  const row = firstRow<{ ok: boolean; reason: string | null; detail: string | null; previous_status: string | null }>(data);
  if (!row) throw new Error('archive_booking returned no result');
  return { ok: row.ok, reason: row.reason, detail: row.detail, previousStatus: row.previous_status };
}

/**
 * Put a booking on the staff "Needs attention" list, e.g. when money arrived
 * for a booking that could not be confirmed automatically. Earlier reasons are
 * kept. Throws if the flag could not be saved, so a payment webhook fails and
 * is retried rather than the problem going unnoticed.
 */
export async function flagBookingForReview(bookingId: string, reason: string) {
  const { data: current, error: loadError } = await supabase.from('bookings').select('attention_reason').eq('id', bookingId).maybeSingle();
  if (loadError) throw loadError;
  const existing = String(current?.attention_reason || '');
  const combined = existing && !existing.includes(reason) ? `${existing}\n\n${reason}` : reason;
  const { error } = await supabase.from('bookings')
    .update({ attention_reason: combined.slice(0, 2000), attention_at: new Date().toISOString() })
    .eq('id', bookingId);
  if (error) throw error;
  console.warn(`Booking ${bookingId} flagged for review: ${reason}`);
}

/** Message for the customer when their booking could not be held or revived. */
export function customerHoldMessage(reason: HoldFailure | null, fallback: string) {
  switch (reason) {
    case 'EXPIRED': return 'The payment window for this booking has closed. Please start a new booking.';
    case 'FULL': return 'Your reservation expired and this date is now fully booked. Please start a new booking for another date.';
    case 'SEAT_TAKEN': return 'Your reservation expired and your hut or table has since been booked by someone else. Please start a new booking.';
    case 'VOUCHER_UNAVAILABLE': return 'Your reservation expired and the voucher balance it used is no longer available. Please start a new booking or contact us.';
    case 'DATE_PASSED': return 'The visit date for this booking has already passed.';
    case 'DATE_CLOSED': return 'Graceland is closed on the date of this booking. Please start a new booking for another date.';
    case 'CANCELLED': return 'This booking has been cancelled. Please contact us if you need help.';
    case 'ALREADY_PAID': return 'This booking is already paid.';
    default: return fallback;
  }
}

/** Date and time in South African time, e.g. "Tuesday, 29 September 2026 at 14:05". */
export function formatJohannesburgDateTime(value: string | Date) {
  return new Intl.DateTimeFormat('en-ZA', { timeZone: 'Africa/Johannesburg', dateStyle: 'full', timeStyle: 'short' }).format(new Date(value));
}
