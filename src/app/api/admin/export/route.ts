import { NextResponse } from 'next/server';
import { AdminAuthError, requireAdmin } from '@/lib/admin-auth';
import { supabase } from '@/lib/supabase';

const csv = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`;

export async function GET(request: Request) {
  try {
    await requireAdmin(request, ['ADMIN', 'MANAGER']);
    const date = new URL(request.url).searchParams.get('date');
    let query = supabase.from('bookings').select('reference,visit_date,status,payment_method,total_amount,people_count,created_at,customers(first_name,last_name,email,phone),booking_items(quantity,subtotal,metadata,packages(name),huts(name))').order('created_at', { ascending: false });
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) query = query.eq('visit_date', date);
    const { data, error } = await query.limit(5000);
    if (error) throw error;
    const rows = ['Booking reference,Visit date,Status,Payment method,Customer,Email,Phone,Headcount,Total amount,Items,Created at'];
    for (const booking of data || []) {
      const customer = Array.isArray(booking.customers) ? booking.customers[0] : booking.customers;
      const items = (booking.booking_items || []).map(item => `${item.packages?.[0]?.name || item.huts?.[0]?.name || item.metadata?.name || 'Item'} x${item.quantity}`).join('; ');
      rows.push([booking.reference, booking.visit_date, booking.status, booking.payment_method, `${customer?.first_name || ''} ${customer?.last_name || ''}`.trim(), customer?.email, customer?.phone, booking.people_count, booking.total_amount, items, booking.created_at].map(csv).join(','));
    }
    return new NextResponse(rows.join('\n'), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="graceland-bookings-${date || 'all'}.csv"`, 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof AdminAuthError) return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    console.error('Admin CSV export error', error);
    return NextResponse.json({ success: false, error: 'Could not export bookings' }, { status: 500 });
  }
}
