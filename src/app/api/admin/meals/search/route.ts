import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { requireAdmin, AdminAuthError } from '@/lib/admin-auth';
import { cleanText } from '@/lib/request-security';

export async function GET(request: Request) {
  try {
    await requireAdmin(request, ['ADMIN', 'MANAGER', 'SCANNER']);

    const { searchParams } = new URL(request.url);
    // Strip characters that have meaning inside a PostgREST filter string.
    const query = cleanText(searchParams.get('q'), 80).replace(/[,()%*]/g, ' ').trim();

    if (query.length < 2) return NextResponse.json({ meals: [] });

    const pattern = `%${query}%`;

    // Bookings that match by reference, or whose customer matches by name/email.
    const [{ data: byReference }, { data: matchingCustomers }] = await Promise.all([
      supabase.from('bookings').select('id').ilike('reference', pattern).limit(50),
      supabase.from('customers').select('id')
        .or(`first_name.ilike.${pattern},last_name.ilike.${pattern},email.ilike.${pattern}`)
        .limit(50),
    ]);
    const customerIds = (matchingCustomers || []).map(c => c.id);
    let byCustomer: Array<{ id: string }> = [];
    if (customerIds.length) {
      const { data } = await supabase.from('bookings').select('id').in('customer_id', customerIds).limit(100);
      byCustomer = data || [];
    }
    const bookingIds = Array.from(new Set([...(byReference || []), ...byCustomer].map(b => b.id)));

    const filters = [`meal_uid.ilike.${pattern}`, `meal_name.ilike.${pattern}`];
    if (bookingIds.length) filters.push(`booking_id.in.(${bookingIds.join(',')})`);

    const { data: meals, error: searchError } = await supabase
      .from('meal_vouchers')
      .select('id, meal_uid, qr_token, visit_date, status, redeemed_at, meal_name, specials(title), bookings(reference, customers(first_name, last_name, email))')
      .or(filters.join(','))
      .order('visit_date', { ascending: false })
      .limit(30);

    if (searchError) throw searchError;

    type Customer = { first_name: string | null; last_name: string | null; email: string | null };
    type BookingRef = { reference: string; customers: Customer | Customer[] | null };
    type MealRow = { id: string; meal_uid: string; qr_token: string; visit_date: string; status: string; redeemed_at: string | null; meal_name: string | null; specials: { title: string } | { title: string }[] | null; bookings: BookingRef | BookingRef[] | null };
    const results = ((meals || []) as unknown as MealRow[]).map(m => {
      const booking = Array.isArray(m.bookings) ? m.bookings[0] : m.bookings;
      const customer = Array.isArray(booking?.customers) ? booking.customers[0] : booking?.customers;
      const special = Array.isArray(m.specials) ? m.specials[0] : m.specials;
      return {
        id: m.id,
        meal_uid: m.meal_uid,
        qr_token: m.qr_token,
        visit_date: m.visit_date,
        meal_name: m.meal_name,
        special_title: special?.title,
        booking_ref: booking?.reference,
        customer_name: [customer?.first_name, customer?.last_name].filter(Boolean).join(' '),
        email: customer?.email,
        status: m.status,
        redeemed: m.status === 'REDEEMED',
        redeemed_at: m.redeemed_at || null,
      };
    });

    return NextResponse.json({ meals: results });
  } catch (error) {
    if (error instanceof AdminAuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error('Meal voucher search error', error);
    return NextResponse.json({ error: 'Could not search meal vouchers. Please try again.' }, { status: 500 });
  }
}
