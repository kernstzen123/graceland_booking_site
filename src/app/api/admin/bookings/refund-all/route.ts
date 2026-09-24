import { NextResponse } from 'next/server';
import { AdminAuthError, requireAdmin, writeAudit } from '@/lib/admin-auth';
import { supabase } from '@/lib/supabase';
import { recordNotificationFailure, sendVoucherEmail } from '@/lib/voucher-email';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function POST(request: Request) {
  try {
    const { user } = await requireAdmin(request, ['ADMIN']);
    const { date, preview } = await request.json();
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ success: false, error: 'A valid booking date is required' }, { status: 400 });
    const { data: bookings, error } = await supabase.from('bookings').select('id,reference,total_amount,customers(first_name,last_name,email)').eq('visit_date', date).in('status', ['PAID', 'CONFIRMED']).eq('voucher_issued', false).order('created_at');
    if (error) throw error;
    // Preview: how many bookings would be refunded, so staff can confirm before anything changes.
    if (preview === true) {
      return NextResponse.json({ success: true, count: (bookings || []).length, total: (bookings || []).reduce((sum, booking) => sum + Number(booking.total_amount), 0) });
    }
    const succeeded: Array<{ bookingId: string; code: string; emailSent: boolean }> = [];
    const failed: Array<{ bookingId: string; reason: string }> = [];
    let emailsSent = 0;
    for (let index = 0; index < (bookings || []).length; index++) {
      const booking = bookings![index];
      try {
        const { data: result, error: refundError } = await supabase.rpc('issue_booking_voucher', { p_booking_id: booking.id, p_created_by: null });
        if (refundError) throw refundError;
        const credit = Array.isArray(result) ? result[0] : result;
        if (!credit) throw new Error('Voucher was not created');
        let emailSent = true;
        try {
          const customer = Array.isArray(booking.customers) ? booking.customers[0] : booking.customers;
          await sendVoucherEmail({ bookingReference: credit.booking_reference || booking.reference, visitDate: date, customerEmail: credit.customer_email || customer?.email || '', customerName: credit.customer_name || [customer?.first_name, customer?.last_name].filter(Boolean).join(' ') || 'Customer', creditCode: credit.credit_code, originalAmount: Number(credit.original_amount) });
          emailsSent++;
        } catch (emailError) {
          emailSent = false;
          await recordNotificationFailure('booking_credit', 'VOUCHER_ISSUED', credit.customer_email || '', credit.credit_id, emailError);
        }
        await writeAudit(user.id, 'ISSUE_VOUCHER_REFUND_BULK', 'booking', booking.id, { credit_code: credit.credit_code, amount: credit.original_amount, date });
        succeeded.push({ bookingId: booking.id, code: credit.credit_code, emailSent });
      } catch (bookingError) {
        failed.push({ bookingId: booking.id, reason: bookingError instanceof Error ? bookingError.message : 'Could not issue voucher' });
      }
      if ((index + 1) % 10 === 0 && index + 1 < (bookings || []).length) await pause(1000);
    }
    return NextResponse.json({ success: true, date, affected: bookings?.length || 0, refunded: succeeded.length, emailsSent, succeeded, failed, message: `${succeeded.length} bookings refunded, ${emailsSent} emails sent, ${failed.length} failed.` });
  } catch (error) {
    if (error instanceof AdminAuthError) return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    console.error('Bulk voucher refund error', error);
    return NextResponse.json({ success: false, error: 'Could not process the date refund' }, { status: 500 });
  }
}
