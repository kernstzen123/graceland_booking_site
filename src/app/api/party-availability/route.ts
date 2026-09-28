import { NextResponse } from 'next/server';
import { getPartySlots } from '@/lib/parties';
import { supabase } from '@/lib/supabase';
import { validateVisitDate } from '@/lib/opening-rules';
import { getClosedDates } from '@/lib/closed-dates';
import { checkRateLimit } from '@/lib/request-security';
import { fetchAllRows } from '@/lib/fetch-all';

/** How far ahead to look for the next date with a free party slot. */
const SEARCH_DAYS = 370;

type Reservation = { spot_id: string; visit_date: string; bookings: { status: string; expires_at: string | null; party_slot: string | null } | Array<{ status: string; expires_at: string | null; party_slot: string | null }> | null };

export async function GET(request: Request) {
  try {
    if (!(await checkRateLimit(request, 'party-availability', 20, 60))) {
      return NextResponse.json({ error: 'Too many requests. Please wait a moment and try again.' }, { status: 429 });
    }
    const date = new URL(request.url).searchParams.get('date') || '';

    // Reject closed or invalid dates before querying party slots
    try { validateVisitDate(date); } catch {
      return NextResponse.json({ date, slots: [], bookedSlots: [], availableSlots: [], nextAvailableDate: null });
    }
    const searchEnd = new Date(`${date}T00:00:00Z`);
    searchEnd.setUTCDate(searchEnd.getUTCDate() + SEARCH_DAYS);
    const endDate = searchEnd.toISOString().slice(0, 10);

    // Everything needed for the whole search window in three queries, instead of
    // one query per day while looking for the next free date.
    const [closedDates, { data: allSpots, error: spotsError }, reserved] = await Promise.all([
      getClosedDates(date, endDate),
      supabase.from('venue_spots').select('id, type'),
      fetchAllRows<Reservation>((from, to) => supabase
        .from('booking_spots')
        .select('spot_id,visit_date,bookings!inner(status,expires_at,party_slot),venue_spots!inner(type)')
        .gte('visit_date', date)
        .lte('visit_date', endDate)
        .eq('venue_spots.type', 'hut')
        .order('id')
        .range(from, to)),
    ]);
    if (spotsError) throw spotsError;
    const totalHutsCount = (allSpots || []).filter(spot => spot.type === 'hut').length;

    // Huts still held on each date, with the party slot of the booking holding them.
    const now = Date.now();
    const heldByDate = new Map<string, Array<{ spotId: string; partySlot: string | null }>>();
    for (const row of reserved) {
      const booking = Array.isArray(row.bookings) ? row.bookings[0] : row.bookings;
      const holding = Boolean(booking && (['PAID', 'CONFIRMED', 'PAYMENT_PENDING'].includes(booking.status) || (booking.status === 'UNPAID' && booking.expires_at && new Date(booking.expires_at).getTime() > now)));
      if (!holding) continue;
      const list = heldByDate.get(String(row.visit_date)) || [];
      list.push({ spotId: row.spot_id, partySlot: booking?.party_slot || null });
      heldByDate.set(String(row.visit_date), list);
    }

    // A slot is available while at least one hut is free for it. A hut is taken
    // for a slot if a day visitor holds it (no party slot) or a party holds it
    // for that same slot.
    const availableSlotsOn = (checkDate: string) => {
      if (closedDates.has(checkDate)) return [];
      const held = heldByDate.get(checkDate) || [];
      return getPartySlots(checkDate).filter(slot => new Set(held.filter(entry => !entry.partySlot || entry.partySlot === slot).map(entry => entry.spotId)).size < totalHutsCount);
    };

    const slots = closedDates.has(date) ? [] : getPartySlots(date);
    const availableSlots = availableSlotsOn(date);
    const bookedSlots = slots.filter(slot => !availableSlots.includes(slot));

    let nextDate: string | null = availableSlots.length ? date : null;
    const cursor = new Date(`${date}T00:00:00Z`);
    for (let offset = 1; !nextDate && offset <= SEARCH_DAYS; offset++) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      const candidate = cursor.toISOString().slice(0, 10);
      if (availableSlotsOn(candidate).length) nextDate = candidate;
    }

    return NextResponse.json({ date, slots, bookedSlots, availableSlots, nextAvailableDate: nextDate });
  } catch (error) {
    console.error('Party availability error', error);
    return NextResponse.json({ error: 'Party availability is temporarily unavailable.' }, { status: 500 });
  }
}
