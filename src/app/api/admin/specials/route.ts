import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { requireAdmin, AdminAuthError } from '@/lib/admin-auth';

export async function GET(request: Request) {
  try {
    await requireAdmin(request);

    const { data: specials, error: fetchError } = await supabase
      .from('specials')
      .select('*')
      .order('created_at', { ascending: false });

    if (fetchError) throw fetchError;
    return NextResponse.json({ specials });
  } catch (error: any) {
    if (error instanceof AdminAuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: error.message || 'Server error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    await requireAdmin(request);

    const body = await request.json();
    const {
      title, description, badge_text, type, paid_tickets, free_tickets, pricing,
      free_meals, valid_from, valid_to, valid_weekdays, stock_limit, max_per_booking
    } = body;

    if (!title || !type || !paid_tickets || !free_tickets || !pricing) {
      return NextResponse.json({ error: 'Missing required special fields' }, { status: 400 });
    }

    const { data, error: insertError } = await supabase
      .from('specials')
      .insert({
        title, description, badge_text, type, paid_tickets, free_tickets, pricing,
        free_meals, valid_from, valid_to, valid_weekdays, stock_limit, max_per_booking
      })
      .select()
      .single();

    if (insertError) throw insertError;
    return NextResponse.json({ special: data });
  } catch (error: any) {
    if (error instanceof AdminAuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: error.message || 'Server error' }, { status: 500 });
  }
}
