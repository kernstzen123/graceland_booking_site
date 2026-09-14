import { NextResponse } from 'next/server';
import { getPartySlots } from '@/lib/parties';
import { supabase } from '@/lib/supabase';

export async function GET(request: Request) {
  const date = new URL(request.url).searchParams.get('date') || '';
  const slots = getPartySlots(date);

  // Fetch all venue spots to count total huts
  const { data: allSpots, error: spotsError } = await supabase
    .from('venue_spots')
    .select('id, type');
  
  if (spotsError) return NextResponse.json({ error: 'Could not load venue spots' }, { status: 500 });
  const totalHutsCount = (allSpots || []).filter(s => s.type === 'hut').length;

  // Fetch all reserved spots for the requested date (and future dates if checking next available)
  // We'll just fetch for the specific date first, then if needed, fetch for candidates.
  // Actually, to make it efficient, we can extract the check logic into a function.

  async function checkSlotsForDate(checkDate: string): Promise<string[]> {
    const candidateSlots = getPartySlots(checkDate);
    if (candidateSlots.length === 0) return [];

    const { data: reserved } = await supabase
      .from('booking_spots')
      .select('spot_id,bookings!inner(status,expires_at,party_slot),venue_spots!inner(type)')
      .eq('visit_date', checkDate)
      .eq('venue_spots.type', 'hut');

    const validReservations = (reserved || []).filter(row => {
      const booking = Array.isArray(row.bookings) ? row.bookings[0] : row.bookings;
      return Boolean(booking && (['PAID', 'CONFIRMED', 'PAYMENT_PENDING'].includes(booking.status) || (booking.status === 'UNPAID' && booking.expires_at && new Date(booking.expires_at).getTime() > Date.now())));
    });

    return candidateSlots.filter(slot => {
      // For this slot, how many unique huts are booked?
      // A hut is booked for this slot if it's booked by a day visitor (party_slot is null) 
      // OR booked by a party for THIS specific slot.
      const bookedHutIds = new Set(
        validReservations.filter(row => {
          const booking = Array.isArray(row.bookings) ? row.bookings[0] : row.bookings;
          return !booking.party_slot || booking.party_slot === slot;
        }).map(r => r.spot_id)
      );

      return bookedHutIds.size < totalHutsCount;
    });
  }

  const availableSlots = await checkSlotsForDate(date);
  // bookedSlots is just slots that are NOT in availableSlots
  const bookedSlots = slots.filter(s => !availableSlots.includes(s));

  let nextDate = availableSlots.length ? date : null;
  if (!nextDate) {
    const cursor = new Date(`${date}T00:00:00Z`);
    for (let offset = 1; offset <= 370; offset++) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      const candidate = cursor.toISOString().slice(0, 10);
      const candAvailable = await checkSlotsForDate(candidate);
      if (candAvailable.length > 0) {
        nextDate = candidate;
        break;
      }
    }
  }

  return NextResponse.json({ date, slots, bookedSlots, availableSlots, nextAvailableDate: nextDate });
}
