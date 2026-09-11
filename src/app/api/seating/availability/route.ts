import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { checkRateLimit } from '@/lib/request-security';

export async function GET(request: Request) {
  try {
    if (!(await checkRateLimit(request, 'seating-availability', 30, 60))) return NextResponse.json({ success: false, error: 'Too many availability requests. Please wait a moment.' }, { status: 429 });
    const date = new URL(request.url).searchParams.get('date') || '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ success: false, error: 'A valid visit date is required.' }, { status: 400 });
    const [{ data: spots, error: spotsError }, { data: reserved, error: reservedError }] = await Promise.all([
      supabase.from('venue_spots').select('id,number,type,capacity,x_percent,y_percent').order('number'),
      supabase.from('booking_spots').select('spot_id,booking_id,bookings!inner(status,expires_at)').eq('visit_date', date),
    ]);
    if (spotsError || reservedError) throw spotsError || reservedError;
    const bookedSpotIds = new Set((reserved || []).filter(row => {
      const booking = Array.isArray(row.bookings) ? row.bookings[0] : row.bookings;
      return Boolean(booking && (['PAID', 'CONFIRMED', 'PAYMENT_PENDING'].includes(booking.status) || (booking.status === 'UNPAID' && booking.expires_at && new Date(booking.expires_at).getTime() > Date.now())));
    }).map(row => row.spot_id));
    return NextResponse.json({ success: true, spots: (spots || []).map(spot => ({ ...spot, available: !bookedSpotIds.has(spot.id) })) });
  } catch (error) {
    console.error('Seating availability error', error);
    return NextResponse.json({ success: false, error: 'Seating availability is temporarily unavailable.' }, { status: 500 });
  }
}
