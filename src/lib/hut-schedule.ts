import 'server-only';
/**
 * Who has each hut and table on a date. Huts: day visitors all day, parties
 * per time slot (one hut can host several parties in different slots, so staff
 * see when a hut must be cleared for the next group). Tables are always held
 * for the whole day, by day visitors and parties alike.
 *
 * Used by the dashboard (/api/admin/hut-schedule) and the daily summary Excel file.
 */
import { supabase } from '@/lib/supabase';
import { getPartySlots } from '@/lib/parties';
import { compareSpots } from '@/lib/seating';

export type HutBooking = { slot: string | null; client: string; reference: string; paid: boolean };
export type SpotBookings = { number: string; bookings: HutBooking[] };
export type HutSchedule = { date: string; slots: string[]; huts: SpotBookings[]; tables: SpotBookings[] };

type Row = {
  spot_id: string;
  bookings: { reference: string; status: string; expires_at: string | null; party_slot: string | null; customers: { first_name: string | null; last_name: string | null } | null } | null;
};

export async function loadHutSchedule(date: string): Promise<HutSchedule> {
  const [{ data: spots, error: spotsError }, { data: held, error: heldError }] = await Promise.all([
    supabase.from('venue_spots').select('id,number,type').eq('active', true),
    supabase.from('booking_spots').select('spot_id,bookings!inner(reference,status,expires_at,party_slot,deleted_at,customers(first_name,last_name))').eq('visit_date', date).is('bookings.deleted_at', null),
  ]);
  if (spotsError || heldError) throw spotsError || heldError;

  const now = Date.now();
  const bookingsByHut = new Map<string, HutBooking[]>();
  for (const row of (held || []) as unknown as Row[]) {
    const booking = row.bookings;
    if (!booking) continue;
    const holding = ['PAID', 'CONFIRMED', 'PAYMENT_PENDING'].includes(booking.status) || (booking.status === 'UNPAID' && booking.expires_at && new Date(booking.expires_at).getTime() > now);
    if (!holding) continue;
    const client = [booking.customers?.first_name, booking.customers?.last_name].filter(Boolean).join(' ') || 'Guest';
    const list = bookingsByHut.get(row.spot_id) || [];
    list.push({ slot: booking.party_slot, client, reference: booking.reference, paid: ['PAID', 'CONFIRMED'].includes(booking.status) });
    bookingsByHut.set(row.spot_id, list);
  }

  const slots: string[] = [...getPartySlots(date)];
  // Include any other slot a booking uses, so nothing is hidden.
  for (const list of bookingsByHut.values()) for (const entry of list) if (entry.slot && !slots.includes(entry.slot)) slots.push(entry.slot);
  slots.sort();

  return {
    date,
    slots,
    huts: [...(spots || [])].filter(spot => spot.type === 'hut').sort(compareSpots).map(hut => ({ number: hut.number, bookings: bookingsByHut.get(hut.id) || [] })),
    tables: [...(spots || [])].filter(spot => spot.type === 'table').sort(compareSpots).map(table => ({ number: table.number, bookings: bookingsByHut.get(table.id) || [] })),
  };
}
