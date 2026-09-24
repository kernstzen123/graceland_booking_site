import { NextResponse } from 'next/server';
import { AdminAuthError, requireAdmin, writeAudit } from '@/lib/admin-auth';
import { supabase } from '@/lib/supabase';
import { getOpeningStatus, johannesburgToday } from '@/lib/opening-rules';
import { fetchAllRows } from '@/lib/fetch-all';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 366;

function isRealDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  return new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function datesBetween(from: string, to: string) {
  const dates: string[] = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor <= end && dates.length <= MAX_RANGE_DAYS) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

/** Bookings that still hold a place on the given dates, grouped by date. */
async function activeBookingsByDate(dates: string[]) {
  const counts = new Map<string, { bookings: number; people: number; paid: number }>();
  if (!dates.length) return counts;
  const wanted = new Set(dates);
  const sorted = [...dates].sort();
  const data = await fetchAllRows((start, end) => supabase
    .from('bookings')
    .select('id,visit_date,status,expires_at,people_count')
    .gte('visit_date', sorted[0])
    .lte('visit_date', sorted[sorted.length - 1])
    .in('status', ['PAID', 'CONFIRMED', 'PAYMENT_PENDING', 'UNPAID'])
    .order('id')
    .range(start, end));
  for (const booking of data) {
    const date = String(booking.visit_date);
    if (!wanted.has(date)) continue;
    if (booking.status === 'UNPAID' && (!booking.expires_at || new Date(booking.expires_at).getTime() <= Date.now())) continue;
    const entry = counts.get(date) || { bookings: 0, people: 0, paid: 0 };
    entry.bookings += 1;
    entry.people += Number(booking.people_count || 0);
    if (['PAID', 'CONFIRMED'].includes(booking.status)) entry.paid += 1;
    counts.set(date, entry);
  }
  return counts;
}

function errorResponse(error: unknown, fallback: string) {
  if (error instanceof AdminAuthError) return NextResponse.json({ success: false, error: error.message }, { status: error.status });
  console.error(fallback, error);
  return NextResponse.json({ success: false, error: `${fallback}. Check that the latest database migration has been applied.` }, { status: 500 });
}

/** GET ?includePast=true — upcoming (or all) admin closures with the bookings still on those dates. */
export async function GET(request: Request) {
  try {
    await requireAdmin(request, ['ADMIN', 'MANAGER']);
    const includePast = new URL(request.url).searchParams.get('includePast') === 'true';
    let query = supabase.from('closed_dates').select('date,reason,created_at,created_by').order('date', { ascending: true });
    if (!includePast) query = query.gte('date', johannesburgToday());
    const { data, error } = await query.limit(1000);
    if (error) throw error;
    const rows = data || [];
    const counts = await activeBookingsByDate(rows.map(row => String(row.date)));
    const closedDates = rows.map(row => ({
      date: String(row.date),
      reason: row.reason || '',
      createdAt: row.created_at,
      activeBookings: counts.get(String(row.date))?.bookings || 0,
      activePeople: counts.get(String(row.date))?.people || 0,
      paidBookings: counts.get(String(row.date))?.paid || 0,
    }));
    return NextResponse.json({ success: true, closedDates });
  } catch (error) {
    return errorResponse(error, 'Could not load closed dates');
  }
}

/**
 * POST { from, to?, reason, preview? }
 * Closes every date in the range. With preview: true nothing is saved; the
 * response lists the bookings affected so staff can confirm first.
 */
export async function POST(request: Request) {
  try {
    const { user } = await requireAdmin(request, ['ADMIN', 'MANAGER']);
    const body = await request.json();
    const from = body?.from;
    const to = body?.to || body?.from;
    const reason = typeof body?.reason === 'string' ? body.reason.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200) : '';
    if (!isRealDate(from) || !isRealDate(to)) return NextResponse.json({ success: false, error: 'Choose a valid date.' }, { status: 400 });
    if (to < from) return NextResponse.json({ success: false, error: 'The end date must be on or after the start date.' }, { status: 400 });
    if (from < johannesburgToday()) return NextResponse.json({ success: false, error: 'Past dates cannot be closed.' }, { status: 400 });
    const dates = datesBetween(from, to);
    if (dates.length > MAX_RANGE_DAYS) return NextResponse.json({ success: false, error: 'Close at most one year at a time.' }, { status: 400 });

    const counts = await activeBookingsByDate(dates);
    const affected = [...counts.entries()].map(([date, entry]) => ({ date, ...entry })).sort((a, b) => a.date.localeCompare(b.date));
    const alreadyClosedByRules = dates.filter(date => !getOpeningStatus(date).open);
    if (body?.preview === true) {
      return NextResponse.json({ success: true, dates: dates.length, affected, alreadyClosedByRules: alreadyClosedByRules.length });
    }

    const { error } = await supabase.from('closed_dates').upsert(dates.map(date => ({ date, reason, created_by: user.id })), { onConflict: 'date' });
    if (error) throw error;
    await writeAudit(user.id, 'CLOSE_DATES', 'closed_dates', from === to ? from : `${from}..${to}`, { from, to, reason, days: dates.length, affectedBookings: affected.reduce((sum, row) => sum + row.bookings, 0) });
    const bookingCount = affected.reduce((sum, row) => sum + row.bookings, 0);
    return NextResponse.json({
      success: true,
      message: `${dates.length} date${dates.length === 1 ? '' : 's'} closed.${bookingCount ? ` ${bookingCount} existing booking${bookingCount === 1 ? ' is' : 's are'} still on ${bookingCount === 1 ? 'that date' : 'those dates'}. Refund or move them from the bookings page.` : ''}`,
      affected,
    });
  } catch (error) {
    return errorResponse(error, 'Could not close dates');
  }
}

/** DELETE ?date=YYYY-MM-DD — reopen a date that was closed from the admin panel. */
export async function DELETE(request: Request) {
  try {
    const { user } = await requireAdmin(request, ['ADMIN', 'MANAGER']);
    const date = new URL(request.url).searchParams.get('date');
    if (!isRealDate(date)) return NextResponse.json({ success: false, error: 'Choose a valid date.' }, { status: 400 });
    const { data, error } = await supabase.from('closed_dates').delete().eq('date', date).select('date,reason');
    if (error) throw error;
    if (!data?.length) return NextResponse.json({ success: false, error: 'That date is not closed.' }, { status: 404 });
    await writeAudit(user.id, 'REOPEN_DATE', 'closed_dates', date, { reason: data[0].reason });
    const regular = getOpeningStatus(date);
    return NextResponse.json({
      success: true,
      message: regular.open ? `${date} is open for bookings again.` : `${date} was removed from the closures, but it stays closed under the regular opening rules (${regular.reason}).`,
    });
  } catch (error) {
    return errorResponse(error, 'Could not reopen date');
  }
}
