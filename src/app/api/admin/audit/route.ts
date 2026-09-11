import { NextResponse } from 'next/server';
import { AdminAuthError, requireAdmin } from '@/lib/admin-auth';
import { supabase } from '@/lib/supabase';

export async function GET(request: Request) {
  try {
    await requireAdmin(request, ['ADMIN', 'MANAGER']);
    const params = new URL(request.url).searchParams;
    const limit = Math.min(500, Math.max(1, Number(params.get('limit') || 200)));
    let query = supabase.from('admin_audit_log').select('id,actor_id,actor_email,action,entity_type,entity_id,details,created_at').order('created_at', { ascending: false }).limit(limit);
    const userId = params.get('userId'); if (userId) query = query.eq('actor_id', userId);
    const { data, error } = await query;
    if (error) throw error;
    return NextResponse.json({ success: true, entries: data || [] });
  } catch (error) {
    if (error instanceof AdminAuthError) return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    console.error('Admin audit error', error);
    return NextResponse.json({ success: false, error: 'Could not load audit log' }, { status: 500 });
  }
}
