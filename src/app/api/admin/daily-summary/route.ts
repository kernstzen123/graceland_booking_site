import { NextResponse } from 'next/server';
import { AdminAuthError, requireAdmin } from '@/lib/admin-auth';
import { supabase } from '@/lib/supabase';
import { getPartySlots } from '@/lib/parties';
import { buildDailySummary, type SummaryBooking } from '@/lib/daily-summary';
import { buildDailySummaryWorkbook } from '@/lib/daily-summary-workbook';
import { loadHutSchedule } from '@/lib/hut-schedule';
import { expireOnlineUnpaidBookings } from '@/lib/booking-holds';

/** The day's bookings (paid, and unpaid ones still holding their places) as a printable Excel sheet (day visitors, then party slots), plus the hut and table schedule. */
export async function GET(request: Request) {
  try {
    await requireAdmin(request, ['ADMIN', 'MANAGER']);
    const date = new URL(request.url).searchParams.get('date') || '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ success: false, error: 'Choose a date' }, { status: 400 });

    await expireOnlineUnpaidBookings();
    const [{ data, error }, schedule] = await Promise.all([supabase
      .from('bookings')
      .select('status,expires_at,party_slot,notes,total_amount,amount_due,voucher_amount_used,payment_method,voucher_issued,payments(amount,status),customers(first_name,last_name),booking_items(quantity,metadata),booking_spots(venue_spots(number,type))')
      .eq('visit_date', date)
      .in('status', ['PAID', 'CONFIRMED', 'PAYMENT_PENDING', 'UNPAID'])
      .is('deleted_at', null)
      .limit(5000), loadHutSchedule(date)]);
    if (error) throw error;

    // Walk-in gate sales are not bookings; a booking refunded with a voucher is no longer coming. An unpaid
    // booking counts while it still holds its places (staff bookings always do; an online one until its payment window ends).
    const now = Date.now();
    const bookings = ((data || []) as unknown as Array<SummaryBooking & { payment_method: string | null; voucher_issued: boolean | null; expires_at: string | null }>)
      .filter(booking => !booking.payment_method?.startsWith('GATE_') && !booking.voucher_issued)
      .filter(booking => booking.status !== 'UNPAID' || (booking.expires_at && new Date(booking.expires_at).getTime() > now));
    const buffer = await buildDailySummaryWorkbook(buildDailySummary(bookings, getPartySlots(date)), date, schedule);
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="graceland-daily-summary-${date}.xlsx"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    if (error instanceof AdminAuthError) return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    console.error('Daily summary export error', error);
    return NextResponse.json({ success: false, error: 'Could not create the daily summary' }, { status: 500 });
  }
}
