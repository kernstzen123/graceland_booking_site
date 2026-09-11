import { NextResponse } from 'next/server';
import { AdminAuthError, requireAdmin } from '@/lib/admin-auth';
import { supabase } from '@/lib/supabase';

const dateString = (date: Date) => date.toISOString().slice(0, 10);

export async function GET(request: Request) {
  try {
    await requireAdmin(request, ['ADMIN', 'MANAGER']);
    const requestedDate = new URL(request.url).searchParams.get('date');
    const today = requestedDate && /^\d{4}-\d{2}-\d{2}$/.test(requestedDate) ? requestedDate : dateString(new Date());
    const selected = new Date(`${today}T00:00:00Z`);
    selected.setUTCDate(selected.getUTCDate() - 7);
    const lastWeek = dateString(selected);
    const { data: bookings, error } = await supabase
      .from('bookings')
      .select('id, reference, visit_date, status, payment_method, total_amount, people_count, customers(first_name,last_name,email,phone), booking_items(quantity,subtotal,metadata,packages(name),huts(name)), tickets(id,status), payment_proofs(status)')
      .in('visit_date', [today, lastWeek]);
    if (error) throw error;

    const todayBookings = (bookings || []).filter(b => b.visit_date === today);
    const lastWeekBookings = (bookings || []).filter(b => b.visit_date === lastWeek);
    const paid = (b: typeof todayBookings[number]) => ['PAID', 'CONFIRMED'].includes(b.status);
    const headcount = (rows: typeof todayBookings) => rows.filter(paid).reduce((sum, b) => sum + Number(b.people_count || 0), 0);
    const revenue = (rows: typeof todayBookings) => rows.filter(paid).reduce((sum, b) => sum + Number(b.total_amount || 0), 0);
    const todayHeadcount = headcount(todayBookings);
    const previousHeadcount = headcount(lastWeekBookings);
    const breakdown: Record<string, { units: number; revenue: number }> = {};
    todayBookings.filter(paid).forEach(booking => {
      (booking.booking_items || []).forEach(item => {
        const packageName = item.packages?.[0]?.name;
        const hutName = item.huts?.[0]?.name;
        const name = packageName || hutName || item.metadata?.name || 'Other';
        breakdown[name] = breakdown[name] || { units: 0, revenue: 0 };
        breakdown[name].units += Number(item.quantity || 0);
        breakdown[name].revenue += Number(item.subtotal || 0);
      });
    });

    const { count: pendingProofs } = await supabase.from('payment_proofs').select('id', { count: 'exact', head: true }).eq('status', 'PENDING');
    const unscanned = todayBookings.filter(paid).reduce((sum, b) => sum + (b.tickets || []).filter(ticket => ticket.status === 'VALID').length, 0);
    const scanned = todayBookings.reduce((sum, b) => sum + (b.tickets || []).filter(ticket => ticket.status === 'USED').length, 0);
    return NextResponse.json({
      success: true,
      date: today,
      today: { headcount: todayHeadcount, revenue: revenue(todayBookings), bookings: todayBookings.length, breakdown, unscanned, scanned, capacity: 500 },
      comparison: { lastWeekHeadcount: previousHeadcount, percent: previousHeadcount ? ((todayHeadcount - previousHeadcount) / previousHeadcount) * 100 : null },
      pendingProofs: pendingProofs || 0,
    });
  } catch (error) {
    if (error instanceof AdminAuthError) return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    console.error('Admin overview error', error);
    return NextResponse.json({ success: false, error: 'Could not load dashboard' }, { status: 500 });
  }
}
