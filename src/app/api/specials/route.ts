import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import type { Special } from '@/lib/specials';
import { specialsSoldOn, specialValidOnWeekday } from '@/lib/specials-server';

/**
 * GET /api/specials?date=YYYY-MM-DD — specials that can be booked for that visit date.
 * Uses the same rules as the booking check: weekdays (0 = Sunday), and stock
 * counted per visit date, including unpaid bookings that are still being held.
 * `remaining` is how many are left that day (null = no limit).
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const date = searchParams.get('date');

    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: 'Invalid date' }, { status: 400 });
    }

    const { data: specials, error } = await supabase
      .from('specials')
      .select('*')
      .eq('active', true)
      .is('archived_at', null)
      .or(`valid_from.is.null,valid_from.lte.${date}`)
      .or(`valid_to.is.null,valid_to.gte.${date}`);

    if (error) throw error;

    const onThisDay = ((specials || []) as Special[]).filter(special => specialValidOnWeekday(special.valid_weekdays, date));
    const sold = await specialsSoldOn(date, onThisDay.filter(special => special.stock_limit !== null).map(special => special.id));

    const available = onThisDay
      .map(special => ({ ...special, remaining: special.stock_limit === null ? null : Math.max(0, special.stock_limit - (sold.get(special.id) || 0)) }))
      .filter(special => special.remaining === null || special.remaining > 0);

    return NextResponse.json(available, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('Error fetching specials:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
