import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { checkRateLimit } from '@/lib/request-security';

export async function POST(request: Request) {
  try {
    if (!(await checkRateLimit(request, 'voucher-validate', 20, 60))) return NextResponse.json({ success: false, error: 'Too many voucher attempts. Please wait a minute and try again.' }, { status: 429 });
    const { code, total } = await request.json();
    if (typeof code !== 'string' || !/^GRC-[A-Z0-9]{8}$/.test(code.trim().toUpperCase()) || !Number.isFinite(Number(total)) || Number(total) <= 0) return NextResponse.json({ success: false, error: 'Enter a valid voucher code.' }, { status: 400 });
    const { data: credit, error } = await supabase.from('booking_credits').select('id,credit_code,remaining_balance,status').eq('credit_code', code.trim().toUpperCase()).maybeSingle();
    if (error) throw error;
    if (!credit || credit.status !== 'active' || Number(credit.remaining_balance) <= 0) return NextResponse.json({ success: false, error: 'That voucher code is invalid or has no remaining balance.' }, { status: 400 });
    const amountUsed = Math.min(Number(credit.remaining_balance), Number(total));
    return NextResponse.json({ success: true, code: credit.credit_code, remainingBalance: Number(credit.remaining_balance), amountUsed, amountDue: Math.max(Number(total) - amountUsed, 0) });
  } catch (error) {
    console.error('Voucher validation error', error);
    return NextResponse.json({ success: false, error: 'We could not validate that voucher. Please try again.' }, { status: 500 });
  }
}
