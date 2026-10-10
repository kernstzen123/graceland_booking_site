import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { requireAdmin, writeAudit } from '@/lib/admin-auth';
import { parseSpecialInput, SpecialInputError } from '@/lib/specials-server';
import { SPECIALS_ROLES, specialsErrorResponse } from '@/lib/specials-admin';

const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireAdmin(request, SPECIALS_ROLES);
    const { id } = await params;
    if (!isUuid(id)) throw new SpecialInputError('Special not found.');
    const special: ReturnType<typeof parseSpecialInput> = parseSpecialInput(await request.json());

    const { data: before, error: loadError } = await supabase.from('specials').select('*').eq('id', id).maybeSingle();
    if (loadError) throw loadError;
    if (!before) return NextResponse.json({ error: 'Special not found.' }, { status: 404 });
    // An emptied "give free over R…" amount switches it off (once the column exists).
    if ('auto_apply_min_spend' in before && special.auto_apply_min_spend === undefined) Object.assign(special, { auto_apply_min_spend: null });

    const { data, error } = await supabase.from('specials').update({ ...special, updated_at: new Date().toISOString() }).eq('id', id).select().single();
    if (error) throw error;
    const changed = Object.fromEntries(Object.entries(special).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(before[key])).map(([key, value]) => [key, { from: before[key], to: value }]));
    await writeAudit(user.id, 'UPDATE_SPECIAL', 'special', id, { title: special.title, changes: changed });
    return NextResponse.json({ special: data });
  } catch (error) {
    return specialsErrorResponse(error, 'Could not update the special.');
  }
}

/** Archives the special (it may have bookings, so it is never deleted). */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireAdmin(request, SPECIALS_ROLES);
    const { id } = await params;
    if (!isUuid(id)) throw new SpecialInputError('Special not found.');
    const { data, error } = await supabase.from('specials').update({ archived_at: new Date().toISOString(), active: false }).eq('id', id).select('title').maybeSingle();
    if (error) throw error;
    if (!data) return NextResponse.json({ error: 'Special not found.' }, { status: 404 });
    await writeAudit(user.id, 'ARCHIVE_SPECIAL', 'special', id, { title: data.title });
    return NextResponse.json({ success: true });
  } catch (error) {
    return specialsErrorResponse(error, 'Could not archive the special.');
  }
}
