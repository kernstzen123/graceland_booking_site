import { NextResponse } from 'next/server';
import { AdminAuthError, requireAdmin } from '@/lib/admin-auth';
import { supabase } from '@/lib/supabase';
import { johannesburgToday } from '@/lib/opening-rules';

/** GET — counts of work waiting, shown as badges in the staff portal menu. */
export async function GET(request: Request) {
  try {
    await requireAdmin(request, ['ADMIN', 'MANAGER']);
    const count = async (query: PromiseLike<{ count: number | null; error: unknown }>) => {
      const { count: value, error } = await query;
      return error ? 0 : value || 0; // a missing table must not break the menu
    };
    // The check-in alerts page opens on today's alerts, so the badge counts the same.
    const today = johannesburgToday();
    const [pendingProofs, conflicts, failedEmails] = await Promise.all([
      count(supabase.from('payment_proofs').select('id', { count: 'exact', head: true }).eq('status', 'PENDING')),
      count(supabase.from('checkin_conflicts').select('id', { count: 'exact', head: true }).eq('resolved', false).gte('created_at', `${today}T00:00:00`).lt('created_at', `${today}T23:59:59.999Z`)),
      count(supabase.from('notification_failures').select('id', { count: 'exact', head: true }).is('resolved_at', null)),
    ]);
    return NextResponse.json({ success: true, pendingProofs, conflicts, failedEmails }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof AdminAuthError) return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    console.error('Admin nav counts error', error);
    return NextResponse.json({ success: false, error: 'Could not load counts' }, { status: 500 });
  }
}
