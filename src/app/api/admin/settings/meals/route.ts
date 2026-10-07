import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { requireAdmin, writeAudit } from '@/lib/admin-auth';
import { SpecialInputError } from '@/lib/specials-server';
import { SPECIALS_ROLES, specialsErrorResponse } from '@/lib/specials-admin';

export async function GET(request: Request) {
  try {
    await requireAdmin(request, SPECIALS_ROLES);
    const { data: settings, error } = await supabase.from('special_settings').select('meal_name').eq('id', 1).maybeSingle();
    if (error) throw error;
    return NextResponse.json({ settings: settings || { meal_name: 'Free Meal' } });
  } catch (error) {
    return specialsErrorResponse(error, 'Could not load the meal settings.');
  }
}

/** PUT { meal_name } — the name printed on meal vouchers. */
export async function PUT(request: Request) {
  try {
    const { user } = await requireAdmin(request, SPECIALS_ROLES);
    const body = await request.json();
    const mealName = typeof body?.meal_name === 'string' ? body.meal_name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80) : '';
    if (!mealName) throw new SpecialInputError('Enter the meal name.');
    const { data: before } = await supabase.from('special_settings').select('meal_name').eq('id', 1).maybeSingle();
    const { data, error } = await supabase.from('special_settings').upsert({ id: 1, meal_name: mealName }).select().single();
    if (error) throw error;
    await writeAudit(user.id, 'UPDATE_MEAL_SETTINGS', 'special_settings', '1', { from: before?.meal_name ?? null, to: mealName });
    return NextResponse.json({ settings: data });
  } catch (error) {
    return specialsErrorResponse(error, 'Could not save the meal settings.');
  }
}
