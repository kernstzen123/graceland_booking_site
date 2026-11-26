import 'server-only';
import { supabase } from '@/lib/supabase';
import { createBookingQrToken } from '@/lib/qr-token';

/**
 * The booking's QR code (one code for the whole booking), made the first time
 * it is needed and kept from then on, so every email the customer gets shows
 * the same code. It is not tied to the visit date (see createBookingQrToken).
 */
export async function ensureBookingQrToken(bookingId: string): Promise<string> {
  const { data: booking, error } = await supabase.from('bookings').select('id,reference,visit_date,qr_token').eq('id', bookingId).maybeSingle();
  if (error) throw error;
  if (!booking) throw new Error(`Booking ${bookingId} not found`);
  if (booking.qr_token) return booking.qr_token;
  const token = createBookingQrToken(booking.id, booking.reference, String(booking.visit_date));
  // Only fill an empty slot, so two emails sent at the same moment end up with the same code.
  const { data: saved, error: saveError } = await supabase.from('bookings').update({ qr_token: token }).eq('id', bookingId).is('qr_token', null).select('qr_token').maybeSingle();
  if (saveError) throw saveError;
  if (saved?.qr_token) return saved.qr_token;
  const { data: current, error: reloadError } = await supabase.from('bookings').select('qr_token').eq('id', bookingId).single();
  if (reloadError) throw reloadError;
  if (!current.qr_token) throw new Error(`Could not save the QR code for booking ${bookingId}`);
  return current.qr_token;
}

/** What a booking QR code encodes: the staff scanner link with the signed booking code (like ticket codes). */
export function bookingScanUrl(appUrl: string, token: string) {
  return `${appUrl}/admin/scanner?token=${encodeURIComponent(token)}`;
}
