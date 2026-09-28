import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

/**
 * GET /api/health — for an uptime monitor (e.g. UptimeRobot): 200 when the site
 * and database respond, 503 otherwise. Reveals nothing else.
 */
export async function GET() {
  const { error } = await supabase.from('business_settings').select('id', { count: 'exact', head: true });
  if (error) {
    console.error('Health check: database unavailable', error);
    return NextResponse.json({ ok: false }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
  return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
}
