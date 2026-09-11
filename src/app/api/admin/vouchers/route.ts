import { NextResponse } from 'next/server';
import { requireAdmin, AdminAuthError } from '@/lib/admin-auth';
import { supabase } from '@/lib/supabase';

export async function GET(request: Request) {
  try {
    await requireAdmin(request, ['ADMIN', 'MANAGER']);
    const params = new URL(request.url).searchParams;
    const query = params.get('q')?.trim().toLowerCase() || '';
    const status = params.get('status') || '';
    let builder = supabase.from('booking_credits').select('id,credit_code,original_amount,remaining_balance,status,created_at,created_by,bookings!booking_credits_original_booking_id_fkey(id,reference,visit_date,customers(first_name,last_name,email)),credit_redemptions(id,booking_id,amount_used,created_at,bookings(reference,visit_date))').order('created_at', { ascending: false }).limit(1000);
    if (status) builder = builder.eq('status', status);
    const { data, error } = await builder;
    if (error) throw error;
    const creatorIds = [...new Set((data || []).map(voucher => voucher.created_by).filter(Boolean))];
    const { data: creators } = creatorIds.length ? await supabase.from('admin_roles').select('id,display_name').in('id', creatorIds) : { data: [] };
    const creatorNames = new Map((creators || []).map(creator => [creator.id, creator.display_name || 'Admin']));
    const vouchers = (data || []).filter(voucher => {
      if (!query) return true;
      const booking = Array.isArray(voucher.bookings) ? voucher.bookings[0] : voucher.bookings;
      const customer = booking && (Array.isArray(booking.customers) ? booking.customers[0] : booking.customers);
      return [voucher.credit_code, customer?.first_name, customer?.last_name, customer?.email, booking?.reference].filter(Boolean).join(' ').toLowerCase().includes(query);
    });
    return NextResponse.json({ success: true, vouchers: vouchers.map(voucher => ({ ...voucher, issued_by: voucher.created_by ? creatorNames.get(voucher.created_by) || 'Admin' : 'Bulk refund' })) });
  } catch (error) {
    if (error instanceof AdminAuthError) return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    console.error('Voucher list error', error);
    return NextResponse.json({ success: false, error: 'Could not load vouchers' }, { status: 500 });
  }
}
