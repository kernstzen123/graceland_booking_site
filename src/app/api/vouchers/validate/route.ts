import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { checkRateLimit, isRateLimited, VOUCHER_FAILURE_LIMIT, VOUCHER_FAILURE_SCOPE, VOUCHER_FAILURE_WINDOW } from '@/lib/request-security';
import { isVoucherCode, normalizeVoucherCode } from '@/lib/voucher-code';

const INVALID = 'That voucher code is invalid or has no remaining balance.';
const LOCKED = 'Too many incorrect voucher codes. Please try again in an hour or contact us.';

export async function POST(request: Request) {
  try {
    if (!(await checkRateLimit(request, 'voucher-validate', 20, 60))) return NextResponse.json({ success: false, error: 'Too many voucher attempts. Please wait a minute and try again.' }, { status: 429 });
    // Guessing protection: an address that entered too many wrong codes is locked out for an hour.
    if (await isRateLimited(request, VOUCHER_FAILURE_SCOPE, VOUCHER_FAILURE_LIMIT, VOUCHER_FAILURE_WINDOW)) return NextResponse.json({ success: false, error: LOCKED }, { status: 429 });
    const { code: rawCode, total } = await request.json();
    const code = normalizeVoucherCode(rawCode);
    const recordFailure = () => checkRateLimit(request, VOUCHER_FAILURE_SCOPE, VOUCHER_FAILURE_LIMIT, VOUCHER_FAILURE_WINDOW);
    if (!Number.isFinite(Number(total)) || Number(total) <= 0) return NextResponse.json({ success: false, error: 'Enter a valid voucher code.' }, { status: 400 });
    if (!isVoucherCode(code)) {
      await recordFailure();
      return NextResponse.json({ success: false, error: 'Enter a valid voucher code.' }, { status: 400 });
    }
    let { data: credit, error } = await supabase.from('booking_credits').select('id,credit_code,remaining_balance,status').eq('credit_code', code).maybeSingle();
    if (error) throw error;
    // Give back any balance still held by a booking whose reservation lapsed
    // (e.g. the customer abandoned an earlier checkout), then read it again.
    if (credit) {
      const { data: released, error: releaseError } = await supabase.rpc('release_expired_booking_vouchers', { p_credit_id: credit.id });
      if (releaseError) console.error('Could not release lapsed voucher holds', releaseError);
      else if (Number(released) > 0) {
        ({ data: credit, error } = await supabase.from('booking_credits').select('id,credit_code,remaining_balance,status').eq('id', credit.id).maybeSingle());
        if (error) throw error;
      }
    }
    if (!credit || credit.status !== 'active' || Number(credit.remaining_balance) <= 0) {
      if (!credit) await recordFailure(); // a used-up but real code is not a guess
      return NextResponse.json({ success: false, error: INVALID }, { status: 400 });
    }
    const amountUsed = Math.min(Number(credit.remaining_balance), Number(total));
    return NextResponse.json({ success: true, code: credit.credit_code, remainingBalance: Number(credit.remaining_balance), amountUsed, amountDue: Math.max(Number(total) - amountUsed, 0) });
  } catch (error) {
    console.error('Voucher validation error', error);
    return NextResponse.json({ success: false, error: 'We could not validate that voucher. Please try again.' }, { status: 500 });
  }
}
