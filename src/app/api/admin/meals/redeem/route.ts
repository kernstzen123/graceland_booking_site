import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { requireAdmin, AdminAuthError } from '@/lib/admin-auth';

export async function POST(request: Request) {
  try {
    await requireAdmin(request);

    const body = await request.json();
    const { token, override_day } = body;

    if (!token) return NextResponse.json({ error: 'Token is required' }, { status: 400 });

    const { data: result, error: rpcError } = await supabase.rpc('redeem_meal_voucher', {
      p_token: token,
      p_override_day: override_day || false
    });

    if (rpcError) throw rpcError;

    return NextResponse.json({
      success: true,
      message: result.message,
      status: result.status,
      details: {
         visit_date: result.visit_date,
         meal_name: result.meal_name,
         redeemed_at: result.redeemed_at
      }
    });

  } catch (error: any) {
    if (error instanceof AdminAuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: error.message || 'Server error' }, { status: 500 });
  }
}
