import { NextResponse } from 'next/server';
import { AdminAuthError, requireAdmin } from '@/lib/admin-auth';
import { supabase } from '@/lib/supabase';
import { johannesburgToday } from '@/lib/opening-rules';

/**
 * GET  /api/admin/conflicts?date=YYYY-MM-DD — list unresolved conflicts
 * PATCH /api/admin/conflicts — resolve a conflict by ID
 */

export async function GET(request: Request) {
  try {
    await requireAdmin(request, ['ADMIN', 'MANAGER']);

    const url = new URL(request.url);
    const date = url.searchParams.get('date') || johannesburgToday();
    const showResolved = url.searchParams.get('resolved') === 'true';

    let query = supabase
      .from('checkin_conflicts')
      .select(`
        id,
        ticket_uid,
        ticket_id,
        first_scan_at,
        first_device_id,
        conflict_scan_at,
        conflict_device_id,
        resolved,
        resolved_at,
        notes,
        created_at
      `)
      .gte('created_at', `${date}T00:00:00`)
      .lt('created_at', `${date}T23:59:59.999Z`)
      .order('created_at', { ascending: false });

    if (!showResolved) {
      query = query.eq('resolved', false);
    }

    const { data: conflicts, error } = await query;
    if (error) throw error;

    // Enrich with customer & ticket info
    const enriched = [];
    for (const conflict of conflicts || []) {
      const { data: ticket } = await supabase
        .from('tickets')
        .select('customers(first_name, last_name), packages(name), bookings(reference)')
        .eq('ticket_uid', conflict.ticket_uid)
        .maybeSingle();

      const customer = ticket?.customers
        ? (Array.isArray(ticket.customers) ? ticket.customers[0] : ticket.customers)
        : null;
      const pkg = ticket?.packages
        ? (Array.isArray(ticket.packages) ? ticket.packages[0] : ticket.packages)
        : null;
      const booking = ticket?.bookings
        ? (Array.isArray(ticket.bookings) ? ticket.bookings[0] : ticket.bookings)
        : null;

      enriched.push({
        ...conflict,
        customer_name: [customer?.first_name, customer?.last_name].filter(Boolean).join(' ') || 'Guest',
        package_name: pkg?.name || 'Entrance Ticket',
        booking_ref: booking?.reference || '',
      });
    }

    return NextResponse.json({ conflicts: enriched, count: enriched.length });
  } catch (error) {
    if (error instanceof AdminAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('Conflicts GET error:', error);
    return NextResponse.json({ error: 'Could not load conflicts' }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const { user } = await requireAdmin(request, ['ADMIN', 'MANAGER']);
    const body = await request.json();
    const { id, notes } = body;

    if (!id) {
      return NextResponse.json({ error: 'Conflict ID is required' }, { status: 400 });
    }

    const { error } = await supabase
      .from('checkin_conflicts')
      .update({
        resolved: true,
        resolved_at: new Date().toISOString(),
        resolved_by: user.id,
        ...(notes ? { notes } : {}),
      })
      .eq('id', id);

    if (error) throw error;

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof AdminAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('Conflicts PATCH error:', error);
    return NextResponse.json({ error: 'Could not resolve conflict' }, { status: 500 });
  }
}
