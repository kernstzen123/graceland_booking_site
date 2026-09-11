import { NextResponse } from 'next/server';
import { requireAdmin, AdminAuthError } from '@/lib/admin-auth';
import { supabase } from '@/lib/supabase';

export async function GET(request: Request) {
  try {
    await requireAdmin(request, ['ADMIN', 'MANAGER']);
    const [{ data: credits, error: creditsError }, { data: redemptions, error: redemptionsError }] = await Promise.all([
      supabase.from('booking_credits').select('original_amount,remaining_balance,status'),
      supabase.from('credit_redemptions').select('amount_used'),
    ]);
    if (creditsError || redemptionsError) throw creditsError || redemptionsError;
    return NextResponse.json({ success: true, summary: {
      totalIssued: (credits || []).reduce((sum, item) => sum + Number(item.original_amount), 0),
      totalRedeemed: (redemptions || []).reduce((sum, item) => sum + Number(item.amount_used), 0),
      outstanding: (credits || []).filter(item => item.status === 'active').reduce((sum, item) => sum + Number(item.remaining_balance), 0),
      totalVoided: (credits || []).filter(item => item.status === 'void').reduce((sum, item) => sum + Number(item.original_amount), 0),
      count: credits?.length || 0,
    } });
  } catch (error) {
    if (error instanceof AdminAuthError) return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    console.error('Voucher summary error', error);
    return NextResponse.json({ success: false, error: 'Could not load voucher summary' }, { status: 500 });
  }
}
