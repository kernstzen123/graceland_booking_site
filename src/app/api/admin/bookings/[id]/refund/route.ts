import { NextResponse } from 'next/server';
import { AdminAuthError, requireAdmin, writeAudit } from '@/lib/admin-auth';
import { supabase } from '@/lib/supabase';
import { recordNotificationFailure, sendVoucherEmail } from '@/lib/voucher-email';

// Messages raised by issue_booking_voucher that are safe to show to staff as-is.
const KNOWN_REFUND_ERRORS = [
  'Booking not found', 'Only paid or confirmed bookings can be refunded', 'Booking has already been refunded',
  'Booking has no paid amount to refund', 'The cancellation fee leaves nothing to refund', 'The cancellation fee must be between',
];

/** POST { deductionPercentage?: number } — cancel a paid booking and issue a rebooking voucher, less the cancellation fee. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireAdmin(request, ['ADMIN']);
    const { id } = await params;

    let body: { deductionPercentage?: unknown } = {};
    try { body = await request.json(); } catch { /* an empty body means a full refund */ }
    const deductionPercentage = Number(body.deductionPercentage ?? 0);
    if (!Number.isFinite(deductionPercentage) || deductionPercentage < 0 || deductionPercentage >= 100 || Math.abs(Math.round(deductionPercentage * 100) - deductionPercentage * 100) > 1e-6) {
      return NextResponse.json({ success: false, error: 'The cancellation fee must be a percentage from 0 to 99.' }, { status: 400 });
    }

    // The fee is applied inside the same database transaction that creates the
    // voucher, so a voucher can never exist for the full amount by mistake.
    const { data, error } = await supabase.rpc('issue_booking_voucher', {
      p_booking_id: id, p_created_by: user.id, p_deduction_percentage: deductionPercentage, p_reason: 'cancellation',
    });
    if (error) {
      const known = KNOWN_REFUND_ERRORS.find(message => error.message?.startsWith(message));
      if (known) return NextResponse.json({ success: false, error: error.message }, { status: 400 });
      throw error;
    }
    const credit = Array.isArray(data) ? data[0] : data;
    if (!credit) return NextResponse.json({ success: false, error: 'The booking could not be refunded' }, { status: 400 });
    const voucherAmount = Number(credit.original_amount);
    const paidAmount = Number(credit.paid_amount ?? voucherAmount);

    await writeAudit(user.id, 'ISSUE_VOUCHER_REFUND', 'booking', id, {
      reference: credit.booking_reference, credit_id: credit.credit_id, credit_code: credit.credit_code,
      paid_amount: paidAmount, amount: voucherAmount, deduction_percentage: deductionPercentage,
    });
    let emailSent = true;
    try {
      await sendVoucherEmail({
        bookingReference: credit.booking_reference, visitDate: credit.visit_date, customerEmail: credit.customer_email,
        customerName: credit.customer_name || 'Customer', creditCode: credit.credit_code, originalAmount: voucherAmount,
        paidAmount, deductionPercentage, reason: 'cancellation',
      });
    } catch (emailError) {
      emailSent = false;
      await recordNotificationFailure('booking_credit', 'VOUCHER_ISSUED', credit.customer_email, credit.credit_id, emailError);
    }
    return NextResponse.json({ success: true, emailSent, credit: { id: credit.credit_id, code: credit.credit_code, originalAmount: voucherAmount }, message: emailSent ? 'Booking cancelled and voucher issued. Email sent.' : 'Booking cancelled and voucher issued. Email delivery failed and was queued for retry.' });

  } catch (error) {
    if (error instanceof AdminAuthError) return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    console.error('Voucher refund error', error);
    return NextResponse.json({ success: false, error: 'Could not issue the rebooking voucher' }, { status: 500 });
  }
}
