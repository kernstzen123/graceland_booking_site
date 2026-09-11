import { NextResponse } from 'next/server';
import { AdminAuthError, requireAdmin } from '@/lib/admin-auth';
import { supabase } from '@/lib/supabase';

/**
 * GET /api/admin/scan/sync-tickets?date=YYYY-MM-DD
 *
 * Downloads all tickets for the given date (defaults to today) with the fields
 * needed for offline validation in the scanner's IndexedDB cache.
 */
export async function GET(request: Request) {
  try {
    const { user } = await requireAdmin(request, ['ADMIN', 'MANAGER', 'SCANNER']);
    void user; // auth verified

    const url = new URL(request.url);
    const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);

    // Validate date format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: 'Invalid date format. Use YYYY-MM-DD.' }, { status: 400 });
    }

    // Fetch all tickets for this date with related data
    const { data: tickets, error: ticketsError } = await supabase
      .from('tickets')
      .select(`
        id,
        ticket_uid,
        booking_id,
        visit_date,
        status,
        qr_token,
        packages(name),
        customers(first_name, last_name),
        bookings(reference, status, voucher_issued)
      `)
      .eq('visit_date', date)
      .in('status', ['VALID', 'USED']);

    if (ticketsError) throw ticketsError;

    // Fetch seating info for all relevant bookings
    const bookingIds = [...new Set((tickets || []).map(t => t.booking_id))];
    let seatingMap: Record<string, string> = {};

    if (bookingIds.length > 0) {
      const { data: allSpots } = await supabase
        .from('booking_spots')
        .select('booking_id, venue_spots(number, type)')
        .in('booking_id', bookingIds);

      if (allSpots) {
        for (const spot of allSpots) {
          const venueSpot = Array.isArray(spot.venue_spots) ? spot.venue_spots[0] : spot.venue_spots;
          if (venueSpot?.number) {
            const label = `${venueSpot.type === 'table' ? 'Table' : 'Hut'} ${venueSpot.number}`;
            seatingMap[spot.booking_id] = seatingMap[spot.booking_id]
              ? `${seatingMap[spot.booking_id]}, ${label}`
              : label;
          }
        }
      }
    }

    // Map to the offline ticket format
    const offlineTickets = (tickets || [])
      .filter(t => {
        // Only include tickets from confirmed/paid bookings
        const booking = Array.isArray(t.bookings) ? t.bookings[0] : t.bookings;
        return booking && ['PAID', 'CONFIRMED'].includes(booking.status);
      })
      .map(t => {
        const customer = Array.isArray(t.customers) ? t.customers[0] : t.customers;
        const pkg = Array.isArray(t.packages) ? t.packages[0] : t.packages;
        const booking = Array.isArray(t.bookings) ? t.bookings[0] : t.bookings;

        return {
          ticket_id: t.id,
          ticket_uid: t.ticket_uid,
          booking_id: t.booking_id,
          booking_ref: booking?.reference || '',
          customer_name: [customer?.first_name, customer?.last_name].filter(Boolean).join(' ') || 'Guest',
          package_name: pkg?.name || 'Entrance Ticket',
          seating: seatingMap[t.booking_id] || '',
          visit_date: t.visit_date,
          status: t.status as 'VALID' | 'USED',
          qr_token: t.qr_token,
          checked_in_at: null,
          checked_in_by_device: null,
        };
      });

    return NextResponse.json({
      tickets: offlineTickets,
      synced_at: new Date().toISOString(),
      count: offlineTickets.length,
    });
  } catch (error) {
    if (error instanceof AdminAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('Sync tickets error:', error);
    return NextResponse.json({ error: 'Could not sync tickets' }, { status: 500 });
  }
}
