import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { checkRateLimit } from '@/lib/request-security';
import { validateBookableDate } from '@/lib/closed-dates';
import { compareSpots, isWholeDay, spotHoldWindow, windowsOverlap } from '@/lib/seating';

export async function GET(request: Request) {
  try {
    if (!(await checkRateLimit(request, 'seating-availability', 30, 60))) return NextResponse.json({ success: false, error: 'Too many availability requests. Please wait a moment.' }, { status: 429 });
    const params = new URL(request.url).searchParams;
    const date = params.get('date') || '';
    const isParty = params.get('isParty') === 'true';
    const partySlot = params.get('partySlot') || '';

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ success: false, error: 'A valid visit date is required.' }, { status: 400 });
    await validateBookableDate(date);
    const [{ data: spots, error: spotsError }, { data: reserved, error: reservedError }] = await Promise.all([
      // Only spots on the current map; retired ones stay on the bookings that already have them.
      supabase.from('venue_spots').select('id,number,type,capacity,x_percent,y_percent').eq('active', true),
      supabase.from('booking_spots').select('spot_id,booking_id,bookings!inner(status,expires_at,party_slot)').eq('visit_date', date),
    ]);
    if (spotsError || reservedError) throw spotsError || reservedError;

    // The bookings still holding each spot (paid, awaiting review, or an unpaid hold that has not lapsed).
    const holders = new Map<string, Array<{ partySlot: string | null }>>();
    (reserved || []).forEach(row => {
      const booking = Array.isArray(row.bookings) ? row.bookings[0] : row.bookings;
      const isValid = Boolean(booking && (['PAID', 'CONFIRMED', 'PAYMENT_PENDING'].includes(booking.status) || (booking.status === 'UNPAID' && booking.expires_at && new Date(booking.expires_at).getTime() > Date.now())));
      if (!isValid) return;
      if (!holders.has(row.spot_id)) holders.set(row.spot_id, []);
      holders.get(row.spot_id)!.push({ partySlot: booking.party_slot || null });
    });

    // A spot is free when no booking holds it during the time this customer
    // needs it: a party only for its slot (plus set-up and clean-up), everyone
    // else, and every table, all day. See spotHoldWindow.
    const requestedSlot = isParty ? partySlot : null;
    const spotsWithAvailability = [...(spots || [])].sort(compareSpots).map(spot => {
      const mine = spotHoldWindow(spot.type, requestedSlot);
      const held = holders.get(spot.id) || [];
      const clashes = held.filter(other => windowsOverlap(mine, spotHoldWindow(spot.type, other.partySlot)));
      if (clashes.length) {
        const allDay = clashes.some(other => isWholeDay(spotHoldWindow(spot.type, other.partySlot)));
        const partySlots = [...new Set(clashes.map(other => other.partySlot).filter((slot): slot is string => Boolean(slot)))].sort();
        const unavailableReason = allDay ? 'Booked for the whole day.' : `Booked for a party (${partySlots.join(', ')}).`;
        return { ...spot, available: false, unavailableReason };
      }
      // Recommend huts another party already uses in a different slot, so parties
      // share a few huts and more huts stay free all day for day visitors.
      const recommended = spot.type === 'hut' && Boolean(requestedSlot) && held.some(other => other.partySlot);
      const note = requestedSlot && spot.type === 'hut' ? (recommended ? 'Free during your party (recommended)' : 'Free all day') : undefined;
      return { ...spot, available: true, recommended, note };
    });

    return NextResponse.json({ success: true, spots: spotsWithAvailability });
  } catch (error) {
    console.error('Seating availability error', error);
    return NextResponse.json({ success: false, error: 'Seating availability is temporarily unavailable.' }, { status: 500 });
  }
}
