import { NextResponse } from 'next/server';
import { checkRateLimit } from '@/lib/request-security';
import { getOpeningStatus } from '@/lib/opening-rules';

/**
 * GET /api/opening-info?from=YYYY-MM&months=N
 *
 * Returns per-date opening status for the requested month range.
 * Only exposes { date, open, hours } — no internal reasons or data.
 * Cap months at 6, default to 3.
 */
export async function GET(request: Request) {
  try {
    if (!(await checkRateLimit(request, 'opening-info', 30, 60))) {
      return NextResponse.json({ error: 'Too many requests. Please wait a moment and try again.' }, { status: 429 });
    }

    const url = new URL(request.url);
    const from = url.searchParams.get('from') || '';
    const monthsParam = parseInt(url.searchParams.get('months') || '3', 10);

    if (!/^\d{4}-\d{2}$/.test(from)) {
      return NextResponse.json({ error: 'Invalid "from" parameter. Use YYYY-MM format.' }, { status: 400 });
    }

    const months = Math.min(Math.max(1, monthsParam), 6);
    const [startYear, startMonth] = from.split('-').map(Number);

    const dates: Array<{ date: string; open: boolean; hours?: { open: string; close: string; poolsClose: string } }> = [];

    for (let offset = 0; offset < months; offset++) {
      let y = startYear;
      let m = startMonth + offset;
      while (m > 12) { m -= 12; y++; }

      // Days in this month
      const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();

      for (let d = 1; d <= daysInMonth; d++) {
        const dateStr = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const status = getOpeningStatus(dateStr);
        dates.push({
          date: dateStr,
          open: status.open,
          ...(status.hours ? { hours: status.hours } : {}),
        });
      }
    }

    return NextResponse.json({ dates });
  } catch (error) {
    console.error('Opening info error', error);
    return NextResponse.json({ error: 'Could not load opening information' }, { status: 500 });
  }
}
