import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { requireAdmin, AdminAuthError } from '@/lib/admin-auth';

export async function GET(request: Request) {
  try {
    await requireAdmin(request);

    const { searchParams } = new URL(request.url);
    const query = searchParams.get('q')?.trim() || '';

    if (query.length < 3) return NextResponse.json({ meals: [] });

    // Try finding meals by meal_uid, booking reference, or customer name/email
    const { data: meals, error: searchError } = await supabase
      .from('meal_vouchers')
      .select(`
        id, meal_uid, qr_token, visit_date, 
        specials(title),
        bookings!inner(reference, customer->>'firstName', customer->>'lastName', customer->>'email')
      `)
      .or(`meal_uid.ilike.%${query}%,bookings.reference.ilike.%${query}%,bookings.customer->>email.ilike.%${query}%,bookings.customer->>firstName.ilike.%${query}%,bookings.customer->>lastName.ilike.%${query}%`)
      .limit(20);

    if (searchError) throw searchError;

    // Check redemption status for these meals
    const mealIds = meals.map((m: any) => m.id);
    let redemptions: Record<string, any> = {};
    if (mealIds.length > 0) {
      const { data: reds } = await supabase
        .from('meal_redemptions')
        .select('meal_voucher_id, redeemed_at')
        .in('meal_voucher_id', mealIds);
      
      for (const r of reds || []) {
        redemptions[r.meal_voucher_id] = r;
      }
    }

    const results = meals.map((m: any) => ({
       id: m.id,
       meal_uid: m.meal_uid,
       qr_token: m.qr_token,
       visit_date: m.visit_date,
       special_title: m.specials?.title,
       booking_ref: m.bookings?.reference,
       customer_name: `${(m.bookings as any)?.firstName} ${(m.bookings as any)?.lastName}`.trim(),
       redeemed_at: redemptions[m.id]?.redeemed_at || null
    }));

    return NextResponse.json({ meals: results });

  } catch (error: any) {
    if (error instanceof AdminAuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: error.message || 'Server error' }, { status: 500 });
  }
}
