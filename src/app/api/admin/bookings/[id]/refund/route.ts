import { NextResponse } from 'next/server';
import { AdminAuthError, requireAdmin, writeAudit } from '@/lib/admin-auth';
import { supabase } from '@/lib/supabase';
import { recordNotificationFailure, sendVoucherEmail } from '@/lib/voucher-email';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireAdmin(request, ['ADMIN']);
    const { id } = await params;

    let body: any = {};
    try { body = await request.json(); } catch { /* ignore empty body */ }
    const deductionPercentage = Number(body.deductionPercentage || 0);
    if (deductionPercentage < 0 || deductionPercentage > 100) {
      return NextResponse.json({ success: false, error: 'Invalid deduction percentage' }, { status: 400 });
    }

    const { data, error } = await supabase.rpc('issue_booking_voucher', { p_booking_id: id, p_created_by: user.id });
    if (error) throw error;
    const credit = Array.isArray(data) ? data[0] : data;
    if (!credit) return NextResponse.json({ success: false, error: 'The booking could not be refunded' }, { status: 400 });

    let finalAmount = Number(credit.original_amount);
    if (deductionPercentage > 0) {
      finalAmount = Math.max(0, finalAmount * ((100 - deductionPercentage) / 100));
      const { error: updateError } = await supabase
        .from('booking_credits')
        .update({ original_amount: finalAmount, remaining_balance: finalAmount })
        .eq('id', credit.credit_id);
      if (updateError) {
        console.error('Could not update credit deduction', updateError);
        throw new Error('Failed to apply deduction fee');
      }
    }

    await writeAudit(user.id, 'ISSUE_VOUCHER_REFUND', 'booking', id, { credit_code: credit.credit_code, amount: finalAmount, deduction_percentage: deductionPercentage });
    let emailSent = true;
    try {
      await sendVoucherEmail({ bookingReference: credit.booking_reference, visitDate: credit.visit_date, customerEmail: credit.customer_email, customerName: credit.customer_name || 'Customer', creditCode: credit.credit_code, originalAmount: finalAmount });
    } catch (emailError) {
      emailSent = false;
      await recordNotificationFailure('booking_credit', 'VOUCHER_ISSUED', credit.customer_email, credit.credit_id, emailError);
    }
    return NextResponse.json({ success: true, emailSent, credit: { id: credit.credit_id, code: credit.credit_code, originalAmount: finalAmount }, message: emailSent ? 'Booking cancelled and voucher issued. Email sent.' : 'Booking cancelled and voucher issued. Email delivery failed and was queued for retry.' });

  } catch (error) {
    if (error instanceof AdminAuthError) return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    console.error('Voucher refund error', error);
    return NextResponse.json({ success: false, error: 'Could not issue the rebooking voucher' }, { status: 500 });
  }
}
