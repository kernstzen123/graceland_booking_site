import { NextResponse } from 'next/server';
import { getPartySlots } from '@/lib/parties';
import { supabase } from '@/lib/supabase';

export async function GET(request: Request) {
  const date = new URL(request.url).searchParams.get('date') || '';
  const slots = getPartySlots(date);
  const { data: items, error } = await supabase
    .from('booking_items')
    .select('metadata,bookings!inner(visit_date,status)')
    .eq('metadata->>party', 'true')
    .in('bookings.status', ['UNPAID', 'PAYMENT_PENDING', 'PAID', 'CONFIRMED']);
  if (error) return NextResponse.json({ error: 'Could not load party availability' }, { status: 500 });

  const bookedSlots = (items || [])
    .filter(item => {
      const booking = Array.isArray(item.bookings) ? item.bookings[0] : item.bookings;
      return booking?.visit_date === date;
    })
    .map(item => typeof item.metadata?.partySlot === 'string' ? item.metadata.partySlot : null)
    .filter((slot): slot is string => Boolean(slot));
  const availableSlots = slots.filter(slot => !bookedSlots.includes(slot));
  let nextDate = availableSlots.length ? date : null;
  if (!nextDate) {
    const cursor = new Date(`${date}T00:00:00Z`);
    for (let offset = 1; offset <= 370; offset++) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      const candidate = cursor.toISOString().slice(0, 10);
      const candidateSlots = getPartySlots(candidate);
      const candidateBooked = (items || [])
        .filter(item => {
          const booking = Array.isArray(item.bookings) ? item.bookings[0] : item.bookings;
          return booking?.visit_date === candidate;
        })
        .map(item => typeof item.metadata?.partySlot === 'string' ? item.metadata.partySlot : null);
      if (candidateSlots.some(slot => !candidateBooked.includes(slot))) { nextDate = candidate; break; }
    }
  }
  return NextResponse.json({ date, slots, bookedSlots, availableSlots, nextAvailableDate: nextDate });
}
