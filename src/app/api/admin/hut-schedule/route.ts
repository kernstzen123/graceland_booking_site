import { NextResponse } from 'next/server';
import { AdminAuthError, requireAdmin } from '@/lib/admin-auth';
import { supabase } from '@/lib/supabase';
import { getPartySlots } from '@/lib/parties';
import { compareSpots } from '@/lib/seating';

type Row = {
  spot_id: string;
  bookings: { reference: string; status: string; expires_at: string | null; party_slot: string | null; customers: { first_name: string | null; last_name: string | null } | null } | null;
};

/**
 * Who has each hut on a date: day visitors all day, parties per time slot.
 * One hut can host several parties in different slots, so staff use this to
 * see when a hut must be cleared for the next group.
 */
export async function GET(request: Request) {
  try {
    await requireAdmin(request, ['ADMIN', 'MANAGER']);
    const date = new URL(request.url).searchParams.get('date') || '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ success: false, error: 'Choose a date' }, { status: 400 });

    const [{ data: huts, error: hutsError }, { data: held, error: heldError }] = await Promise.all([
      supabase.from('venue_spots').select('id,number,type').eq('active', true).eq('type', 'hut'),
      supabase.from('booking_spots').select('spot_id,bookings!inner(reference,status,expires_at,party_slot,deleted_at,customers(first_name,last_name))').eq('visit_date', date).is('bookings.deleted_at', null),
    ]);
    if (hutsError || heldError) throw hutsError || heldError;

    const now = Date.now();
    const bookingsByHut = new Map<string, Array<{ slot: string | null; client: string; reference: string; paid: boolean }>>();
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

    return NextResponse.json({
      date,
      slots,
      huts: [...(huts || [])].sort(compareSpots).map(hut => ({ number: hut.number, bookings: bookingsByHut.get(hut.id) || [] })),
    });
  } catch (error) {
    if (error instanceof AdminAuthError) return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    console.error('Hut schedule error', error);
    return NextResponse.json({ success: false, error: 'Could not load the hut schedule' }, { status: 500 });
  }
}
