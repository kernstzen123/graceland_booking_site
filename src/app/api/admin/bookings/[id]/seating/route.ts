import { NextResponse } from 'next/server';
import { AdminAuthError, requireAdmin } from '@/lib/admin-auth';
import { supabase } from '@/lib/supabase';
import { compareSpots, spotHoldWindow, windowsOverlap } from '@/lib/seating';
import { getPartySlots } from '@/lib/parties';

const HOLDING = ['UNPAID', 'PAYMENT_PENDING', 'PAID', 'CONFIRMED'];

/**
 * GET ?date=YYYY-MM-DD[&slot=09:30–11:30] — every hut and table on the current map, for the
 * booking's seating dropdowns, with whether another booking holds it on that
 * date. Uses the same rule as the database (reserve_booking_spots): a party
 * holds its hut for its time slot only, anyone else holds a spot all day.
 * `slot` checks a party booking as if it were in that time slot (when staff
 * are moving it); `slots` lists the party time slots on that date.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin(request, ['ADMIN', 'MANAGER']);
    const { id } = await params;
    const search = new URL(request.url).searchParams;
    const date = search.get('date') || '';
    const requestedSlot = search.get('slot');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ success: false, error: 'Choose a valid date.' }, { status: 400 });

    const [{ data: booking, error: bookingError }, { data: spots, error: spotsError }, { data: held, error: heldError }] = await Promise.all([
      supabase.from('bookings').select('id,party_slot,booking_spots(spot_id)').eq('id', id).maybeSingle(),
      supabase.from('venue_spots').select('id,number,type,capacity').eq('active', true),
      supabase.from('booking_spots').select('spot_id,booking_id,bookings!inner(reference,status,expires_at,party_slot,deleted_at)').eq('visit_date', date).neq('booking_id', id),
    ]);
    if (bookingError) throw bookingError;
    if (spotsError) throw spotsError;
    if (heldError) throw heldError;
    if (!booking) return NextResponse.json({ success: false, error: 'Booking not found' }, { status: 404 });

    const partySlot = booking.party_slot ? (requestedSlot || booking.party_slot) : null;
    const now = Date.now();
    const takenBy = new Map<string, string>();
    for (const row of held || []) {
      const other = (Array.isArray(row.bookings) ? row.bookings[0] : row.bookings) as { reference: string; status: string; expires_at: string | null; party_slot: string | null } | null;
      if (!other || !HOLDING.includes(other.status)) continue;
      if (other.status === 'UNPAID' && !(other.expires_at && new Date(other.expires_at).getTime() > now)) continue;
      const spot = (spots || []).find(s => s.id === row.spot_id);
      if (!spot) continue;
      if (windowsOverlap(spotHoldWindow(spot.type, other.party_slot), spotHoldWindow(spot.type, partySlot))) {
        takenBy.set(row.spot_id, [takenBy.get(row.spot_id), other.reference].filter(Boolean).join(', '));
      }
    }

    return NextResponse.json({
      success: true,
      current: (booking.booking_spots || []).map(row => row.spot_id),
      slots: getPartySlots(date),
      spots: [...(spots || [])].sort(compareSpots).map(spot => ({ ...spot, takenBy: takenBy.get(spot.id) || null })),
    });
  } catch (error) {
    if (error instanceof AdminAuthError) return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    console.error('Booking seating options error', error);
    return NextResponse.json({ success: false, error: 'Could not load the seating.' }, { status: 500 });
  }
}
