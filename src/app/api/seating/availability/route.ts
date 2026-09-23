import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { checkRateLimit } from '@/lib/request-security';
import { validateVisitDate } from '@/lib/opening-rules';

export async function GET(request: Request) {
  try {
    if (!(await checkRateLimit(request, 'seating-availability', 30, 60))) return NextResponse.json({ success: false, error: 'Too many availability requests. Please wait a moment.' }, { status: 429 });
    const params = new URL(request.url).searchParams;
    const date = params.get('date') || '';
    const isParty = params.get('isParty') === 'true';
    const partySlot = params.get('partySlot') || '';

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ success: false, error: 'A valid visit date is required.' }, { status: 400 });
    validateVisitDate(date);
    const [{ data: spots, error: spotsError }, { data: reserved, error: reservedError }] = await Promise.all([
      supabase.from('venue_spots').select('id,number,type,capacity,x_percent,y_percent').order('number'),
      supabase.from('booking_spots').select('spot_id,booking_id,bookings!inner(status,expires_at,party_slot)').eq('visit_date', date),
    ]);
    if (spotsError || reservedError) throw spotsError || reservedError;

    // Group valid bookings by spot_id
    const spotBookings = new Map<string, Array<{ party_slot: string | null }>>();
    (reserved || []).forEach(row => {
      const booking = Array.isArray(row.bookings) ? row.bookings[0] : row.bookings;
      const isValid = Boolean(booking && (['PAID', 'CONFIRMED', 'PAYMENT_PENDING'].includes(booking.status) || (booking.status === 'UNPAID' && booking.expires_at && new Date(booking.expires_at).getTime() > Date.now())));
      if (isValid) {
        if (!spotBookings.has(row.spot_id)) spotBookings.set(row.spot_id, []);
        spotBookings.get(row.spot_id)!.push({ party_slot: booking.party_slot });
      }
    });

    const spotsWithAvailability = (spots || []).map(spot => {
      let available = true;
      let unavailableReason = undefined;
      const bookingsForSpot = spotBookings.get(spot.id) || [];

      if (spot.type === 'hut') {
        if (isParty) {
          // Party booker
          const dayVisitorBooking = bookingsForSpot.find(b => !b.party_slot);
          const sameSlotBooking = bookingsForSpot.find(b => b.party_slot === partySlot);
          
          if (dayVisitorBooking) {
            available = false;
            unavailableReason = 'Booked by a day visitor for the entire day.';
          } else if (sameSlotBooking) {
            available = false;
            unavailableReason = `Booked for a party during the ${partySlot} slot.`;
          }
        } else {
          // Normal day visitor booking
          if (bookingsForSpot.length > 0) {
            available = false;
            const partyBookings = bookingsForSpot.filter(b => b.party_slot);
            if (partyBookings.length > 0) {
              const endTimes = partyBookings.map(b => b.party_slot!.split('–')[1]).filter(Boolean).sort();
              const latestTime = endTimes[endTimes.length - 1];
              if (latestTime) {
                unavailableReason = `Reserved for a party until ${latestTime}.`;
              } else {
                unavailableReason = 'Reserved.';
              }
            } else {
              unavailableReason = 'Already booked.';
            }
          }
        }
      } else {
        // Tables just have standard availability
        if (bookingsForSpot.length > 0) {
          available = false;
          unavailableReason = 'Already booked.';
        }
      }

      return { ...spot, available, unavailableReason };
    });

    return NextResponse.json({ success: true, spots: spotsWithAvailability });
  } catch (error) {
    console.error('Seating availability error', error);
    return NextResponse.json({ success: false, error: 'Seating availability is temporarily unavailable.' }, { status: 500 });
  }
}
