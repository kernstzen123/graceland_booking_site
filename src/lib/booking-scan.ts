import 'server-only';
import { supabase } from '@/lib/supabase';
import { verifyQrToken } from '@/lib/qr-token';
import { BOOKING_CARD_SELECT, bookingIsActive, buildBookingCard, type BookingCard, type BookingCardRow } from '@/lib/booking-card';
import { generateTicketsAndSendEmail } from '@/lib/ticketing';

/**
 * Finding the booking behind whatever the gate scanned or typed: the booking's
 * own QR code, an older per-person ticket QR code (it opens the whole booking),
 * a ticket ID (TKT-…) or a booking reference (BK-…). Meal vouchers are told
 * apart so the scanner can redeem them as before.
 */
export type ScanTarget = { bookingId: string } | { mealUid: string } | { error: string };

/** The signed code inside a scanned value: the QR codes hold the scanner link with ?token=…, typed values are used as they are. */
export function tokenFromScan(value: string) {
  const trimmed = value.trim();
  try { return new URL(trimmed).searchParams.get('token') || trimmed; } catch { return trimmed; }
}

export async function resolveScanCode(input: { token?: string; ticketUid?: string; reference?: string }): Promise<ScanTarget> {
  const token = input.token ? tokenFromScan(input.token) : '';
  if (token) {
    const claims = verifyQrToken(token);
    if (!claims) return { error: 'This QR code is not valid or has expired.' };
    if (claims.type === 'meal') return { mealUid: claims.tid };
    if (claims.type === 'booking') {
      const { data: booking, error } = await supabase.from('bookings').select('id,qr_token').eq('id', claims.bid).maybeSingle();
      if (error) throw error;
      if (!booking || booking.qr_token !== token) return { error: 'This booking QR code is not recognised. Search for the booking by name or reference instead.' };
      return { bookingId: booking.id };
    }
    const { data: ticket, error } = await supabase.from('tickets').select('booking_id,ticket_uid').eq('qr_token', token).maybeSingle();
    if (error) throw error;
    if (!ticket) {
      // Older meal voucher codes carry no type marker.
      const { data: meal, error: mealError } = await supabase.from('meal_vouchers').select('meal_uid').eq('qr_token', token).maybeSingle();
      if (mealError) throw mealError;
      return meal ? { mealUid: meal.meal_uid } : { error: 'Ticket not found. It may have been replaced when the booking was changed.' };
    }
    if (ticket.booking_id !== claims.bid || ticket.ticket_uid !== claims.tid) return { error: 'This QR code is not valid.' };
    return { bookingId: ticket.booking_id };
  }
  const ticketUid = (input.ticketUid || '').trim().toUpperCase();
  if (ticketUid) {
    if (ticketUid.startsWith('MEAL-')) return { mealUid: ticketUid };
    const { data: ticket, error } = await supabase.from('tickets').select('booking_id').eq('ticket_uid', ticketUid).maybeSingle();
    if (error) throw error;
    return ticket ? { bookingId: ticket.booking_id } : { error: 'Ticket not found.' };
  }
  const reference = (input.reference || '').trim().toUpperCase();
  if (reference) {
    const { data: booking, error } = await supabase.from('bookings').select('id').eq('reference', reference).maybeSingle();
    if (error) throw error;
    return booking ? { bookingId: booking.id } : { error: 'Booking not found.' };
  }
  return { error: 'Scan a QR code, or enter a ticket ID or booking reference.' };
}

/** The booking card for the scanner, with when the group was last checked in. */
export async function loadBookingCard(bookingId: string): Promise<{ card: BookingCard; lastCheckInAt: string | null } | null> {
  const { data, error } = await supabase.from('bookings').select(BOOKING_CARD_SELECT).eq('id', bookingId).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const { data: scans, error: scansError } = await supabase.from('ticket_scans')
    .select('scanned_at,tickets!inner(booking_id)')
    .eq('tickets.booking_id', bookingId).eq('result_status', 'APPROVED')
    .order('scanned_at', { ascending: false }).limit(1);
  if (scansError) throw scansError;
  return { card: buildBookingCard(data as unknown as BookingCardRow), lastCheckInAt: scans?.[0]?.scanned_at || null };
}

/**
 * A booking that is still active but has no tickets yet (an unpaid booking staff
 * added before booking QR codes existed) gets its tickets now, without an email,
 * so its people can be checked in. Returns false when there is nothing to make.
 */
export async function ensureBookingTickets(bookingId: string): Promise<boolean> {
  const { data: booking, error } = await supabase.from('bookings').select('id,status,expires_at,deleted_at,voucher_issued,tickets(id)').eq('id', bookingId).maybeSingle();
  if (error) throw error;
  if (!booking || !bookingIsActive(booking) || (booking.tickets || []).length) return Boolean(booking?.tickets?.length);
  try {
    await generateTicketsAndSendEmail(bookingId, '', 'Customer', { sendEmail: false });
    return true;
  } catch (ticketError) {
    console.error(`Could not make tickets for booking ${bookingId} at the gate`, ticketError);
    return false;
  }
}

export type CheckInResult = { ok: boolean; reason: string | null; detail: string | null; checkedIn: string[]; used: number; total: number };

/** Check in `count` of a booking's people (the next unused tickets), in one step in the database. */
export async function checkInBooking(bookingId: string, count: number, userId: string, deviceId: string | null): Promise<CheckInResult> {
  const { data, error } = await supabase.rpc('check_in_booking', { p_booking_id: bookingId, p_count: count, p_scanned_by: userId, p_device_id: deviceId });
  if (error) {
    if (error.code === 'PGRST202') throw new Error('The scanner needs the latest database update (supabase/migrations/20261017_booking_qr_checkin.sql).');
    throw error;
  }
  const row = (Array.isArray(data) ? data[0] : data) as { ok: boolean; reason: string | null; detail: string | null; checked_in: string[] | null; used: number; total: number } | null;
  if (!row) throw new Error('check_in_booking returned no result');
  return { ok: row.ok, reason: row.reason, detail: row.detail, checkedIn: row.checked_in || [], used: Number(row.used) || 0, total: Number(row.total) || 0 };
}
