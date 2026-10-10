import { NextResponse } from 'next/server';
import { AdminAuthError, requireAdmin } from '@/lib/admin-auth';
import { loadHutSchedule } from '@/lib/hut-schedule';

/** Who has each hut and table on a date (see src/lib/hut-schedule.ts). */
export async function GET(request: Request) {
  try {
    await requireAdmin(request, ['ADMIN', 'MANAGER']);
    const date = new URL(request.url).searchParams.get('date') || '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ success: false, error: 'Choose a date' }, { status: 400 });
    return NextResponse.json(await loadHutSchedule(date));
  } catch (error) {
    if (error instanceof AdminAuthError) return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    console.error('Hut and table schedule error', error);
    return NextResponse.json({ success: false, error: 'Could not load the hut and table schedule' }, { status: 500 });
  }
}
