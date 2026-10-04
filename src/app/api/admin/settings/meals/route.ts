import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { requireAdmin, AdminAuthError } from '@/lib/admin-auth';

export async function GET(request: Request) {
  try {
    await requireAdmin(request);

    const { data: settings, error: fetchError } = await supabase
      .from('special_settings')
      .select('meal_name')
      .eq('id', 1)
      .maybeSingle();

    if (fetchError) throw fetchError;
    return NextResponse.json({ settings: settings || { meal_name: 'Free Meal' } });
  } catch (error: any) {
    if (error instanceof AdminAuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: error.message || 'Server error' }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    await requireAdmin(request);

    const body = await request.json();
    const { meal_name } = body;

    const { data, error: updateError } = await supabase
      .from('special_settings')
      .upsert({ id: 1, meal_name })
      .select()
      .single();

    if (updateError) throw updateError;
    return NextResponse.json({ settings: data });
  } catch (error: any) {
    if (error instanceof AdminAuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: error.message || 'Server error' }, { status: 500 });
  }
}
