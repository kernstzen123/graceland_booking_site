import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import type { Special } from '@/lib/specials';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const date = searchParams.get('date');

    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: 'Invalid date' }, { status: 400 });
    }

    const targetDate = new Date(`${date}T00:00:00Z`);
    const dayOfWeek = targetDate.getDay(); // 0 = Sunday, 1 = Monday...

    const { data: specials, error } = await supabase
      .from('specials')
      .select('*')
      .eq('active', true)
      .or(`valid_from.is.null,valid_from.lte.${date}`)
      .or(`valid_to.is.null,valid_to.gte.${date}`);

    if (error) throw error;

    // Filter by weekday
    let availableSpecials = (specials as Special[]).filter(s => 
      !s.valid_weekdays || s.valid_weekdays.length === 0 || s.valid_weekdays.includes(dayOfWeek)
    );

    // If there are stock limits, calculate current usage
    const specialsWithLimit = availableSpecials.filter(s => s.stock_limit !== null);
    if (specialsWithLimit.length > 0) {
      const specialIds = specialsWithLimit.map(s => s.id);
      
      const { data: usageData, error: usageError } = await supabase
        .from('booking_specials')
        .select(`
          special_id,
          quantity,
          bookings!inner(visit_date, status)
        `)
        .eq('bookings.visit_date', date)
        .in('bookings.status', ['PAID', 'PENDING'])
        .in('special_id', specialIds);
        
      if (usageError) throw usageError;

      // Group usage by special_id
      const usageMap: Record<string, number> = {};
      for (const row of usageData || []) {
        usageMap[row.special_id] = (usageMap[row.special_id] || 0) + row.quantity;
      }

      availableSpecials = availableSpecials.filter(s => {
        if (s.stock_limit === null) return true;
        const used = usageMap[s.id] || 0;
        return used < s.stock_limit;
      });
    }

    return NextResponse.json(availableSpecials);
  } catch (error) {
    console.error('Error fetching specials:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
