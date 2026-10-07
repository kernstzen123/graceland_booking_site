import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { requireAdmin, writeAudit } from '@/lib/admin-auth';
import { parseSpecialInput } from '@/lib/specials-server';
import { SPECIALS_ROLES, specialsErrorResponse } from '@/lib/specials-admin';

export async function GET(request: Request) {
  try {
    await requireAdmin(request, SPECIALS_ROLES);
    const { data: specials, error } = await supabase.from('specials').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    return NextResponse.json({ specials });
  } catch (error) {
    return specialsErrorResponse(error, 'Could not load specials.');
  }
}

export async function POST(request: Request) {
  try {
    const { user } = await requireAdmin(request, SPECIALS_ROLES);
    const special = parseSpecialInput(await request.json());
    const { data, error } = await supabase.from('specials').insert({ ...special, created_by: user.id }).select().single();
    if (error) throw error;
    await writeAudit(user.id, 'CREATE_SPECIAL', 'special', data.id, { title: special.title, pricing: special.pricing, paid_tickets: special.paid_tickets, free_tickets: special.free_tickets, active: special.active });
    return NextResponse.json({ special: data });
  } catch (error) {
    return specialsErrorResponse(error, 'Could not create the special.');
  }
}
