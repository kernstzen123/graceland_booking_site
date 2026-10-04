import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { requireAdmin, AdminAuthError } from '@/lib/admin-auth';
import { verifyQrToken } from '@/lib/qr-token';

export async function POST(request: Request) {
  try {
    const { user } = await requireAdmin(request);

    const body = await request.json();
    const { token } = body;

    if (!token) return NextResponse.json({ error: 'Token is required' }, { status: 400 });

    let mealUid = token;
    
    // Check if it's a full QR token
    if (token.includes('.')) {
      const claims = verifyQrToken(token);
      if (!claims) {
        return NextResponse.json({ error: 'Invalid or expired QR code' }, { status: 400 });
      }
      mealUid = claims.tid;
    }

    const { data: result, error: rpcError } = await supabase.rpc('redeem_meal_voucher', {
      p_meal_uid: mealUid,
      p_scanned_by: user.id
    });

    if (rpcError) throw rpcError;

    const row = Array.isArray(result) ? result[0] : result;
    if (!row) throw new Error('No response from database');

    return NextResponse.json({
      success: row.ok,
      message: row.error_message,
      status: row.status,
      details: {
         meal_name: row.meal_name,
      }
    });

  } catch (error: any) {
    if (error instanceof AdminAuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: error.message || 'Server error' }, { status: 500 });
  }
}
