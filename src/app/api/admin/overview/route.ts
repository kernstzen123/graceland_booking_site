import { NextResponse } from 'next/server';
import { AdminAuthError, requireAdmin } from '@/lib/admin-auth';
import { supabase } from '@/lib/supabase';
import { johannesburgToday } from '@/lib/opening-rules';

type DayOverview = {
  headcount: number; revenue: number; bookings: number; breakdown: Record<string, { units: number; revenue: number }>;
  unscanned: number; scanned: number; lastWeekHeadcount: number; pendingProofs: number; capacity: number;
};

export async function GET(request: Request) {
  try {
    await requireAdmin(request, ['ADMIN', 'MANAGER']);
    const requestedDate = new URL(request.url).searchParams.get('date');
    const date = requestedDate && /^\d{4}-\d{2}-\d{2}$/.test(requestedDate) ? requestedDate : johannesburgToday();

    // All of the day's numbers are added up inside the database in one call.
    const { data, error } = await supabase.rpc('admin_day_overview', { p_date: date });
    if (error) {
      if (error.code === 'PGRST202') return NextResponse.json({ success: false, error: 'The dashboard needs the latest database migration (supabase/migrations/20260926_admin_search_and_stats.sql).' }, { status: 500 });
      throw error;
    }
    const day = data as DayOverview;
    const headcount = Number(day.headcount);
    const previous = Number(day.lastWeekHeadcount);
    return NextResponse.json({
      success: true,
      date,
      today: {
        headcount,
        revenue: Number(day.revenue),
        bookings: Number(day.bookings),
        breakdown: Object.fromEntries(Object.entries(day.breakdown || {}).map(([name, value]) => [name, { units: Number(value.units), revenue: Number(value.revenue) }])),
        unscanned: Number(day.unscanned),
        scanned: Number(day.scanned),
        capacity: Number(day.capacity) || 500,
      },
      comparison: { lastWeekHeadcount: previous, percent: previous ? ((headcount - previous) / previous) * 100 : null },
      pendingProofs: Number(day.pendingProofs),
    });
  } catch (error) {
    if (error instanceof AdminAuthError) return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    console.error('Admin overview error', error);
    return NextResponse.json({ success: false, error: 'Could not load dashboard' }, { status: 500 });
  }
}
