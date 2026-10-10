import { NextResponse } from 'next/server';
import { AdminAuthError, requireAdmin, writeAudit } from '@/lib/admin-auth';
import { supabase } from '@/lib/supabase';
import { recordNotificationFailure, sendVoucherEmail } from '@/lib/voucher-email';
import { voucherRefundAmount } from '@/lib/imported-payments';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const one = <T,>(value: T | T[] | null | undefined) => (Array.isArray(value) ? value[0] : value) ?? null;

/**
 * POST { date, preview: true } — every paid booking on that date with the voucher it would get,
 * so staff can check the list before anything changes.
 * POST { date, bookingIds } — issue the vouchers, for the bookings staff confirmed only (a booking
 * made after the list was shown is left alone).
 */
export async function POST(request: Request) {
  try {
    const { user } = await requireAdmin(request, ['ADMIN']);
    const { date, preview, bookingIds } = await request.json();
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ success: false, error: 'A valid booking date is required' }, { status: 400 });
    const { data: found, error } = await supabase.from('bookings')
      .select('id,reference,total_amount,people_count,payment_method,party_slot,customers(first_name,last_name,email),payments(amount,status)')
      .eq('visit_date', date).in('status', ['PAID', 'CONFIRMED']).eq('voucher_issued', false).is('deleted_at', null).order('created_at');
    if (error) throw error;
    if (preview === true) {
      const rows = (found || []).map(booking => {
        const customer = one(booking.customers);
        return {
          id: booking.id,
          reference: booking.reference,
          customerName: [customer?.first_name, customer?.last_name].filter(Boolean).join(' ') || 'Customer',
          email: customer?.email || '',
          people: Number(booking.people_count || 0),
          partySlot: booking.party_slot || null,
          total: Number(booking.total_amount),
          voucher: voucherRefundAmount(booking),
        };
      });
      const refundable = rows.filter(row => row.voucher > 0);
      return NextResponse.json({ success: true, date, bookings: rows, count: refundable.length, total: refundable.reduce((sum, row) => sum + row.voucher, 0) });
    }
    if (!Array.isArray(bookingIds) || !bookingIds.length || bookingIds.some(id => typeof id !== 'string')) {
      return NextResponse.json({ success: false, error: 'Check the list of bookings to refund first.' }, { status: 400 });
    }
    const confirmed = new Set(bookingIds as string[]);
    const bookings = (found || []).filter(booking => confirmed.has(booking.id));
    const succeeded: Array<{ bookingId: string; code: string; emailSent: boolean }> = [];
    const failed: Array<{ bookingId: string; reference: string; reason: string }> = [];
    let emailsSent = 0;
    for (let index = 0; index < (bookings || []).length; index++) {
      const booking = bookings![index];
      try {
        const { data: result, error: refundError } = await supabase.rpc('issue_booking_voucher', { p_booking_id: booking.id, p_created_by: null, p_deduction_percentage: 0, p_reason: 'closure' });
        if (refundError) throw refundError;
        const credit = Array.isArray(result) ? result[0] : result;
        if (!credit) throw new Error('Voucher was not created');
        let emailSent = true;
        try {
          const customer = Array.isArray(booking.customers) ? booking.customers[0] : booking.customers;
          await sendVoucherEmail({ bookingReference: credit.booking_reference || booking.reference, visitDate: date, customerEmail: credit.customer_email || customer?.email || '', customerName: credit.customer_name || [customer?.first_name, customer?.last_name].filter(Boolean).join(' ') || 'Customer', creditCode: credit.credit_code, originalAmount: Number(credit.original_amount), paidAmount: Number(credit.paid_amount ?? credit.original_amount), reason: 'closure' });
          emailsSent++;
        } catch (emailError) {
          emailSent = false;
          await recordNotificationFailure('booking_credit', 'VOUCHER_ISSUED', credit.customer_email || '', credit.credit_id, emailError);
        }
        await writeAudit(user.id, 'ISSUE_VOUCHER_REFUND_BULK', 'booking', booking.id, { reference: credit.booking_reference || booking.reference, credit_id: credit.credit_id, credit_code: credit.credit_code, amount: credit.original_amount, date });
        succeeded.push({ bookingId: booking.id, code: credit.credit_code, emailSent });
      } catch (bookingError) {
        failed.push({ bookingId: booking.id, reference: booking.reference, reason: bookingError instanceof Error ? bookingError.message : String((bookingError as { message?: string })?.message || 'Could not issue voucher') });
      }
      if ((index + 1) % 10 === 0 && index + 1 < (bookings || []).length) await pause(1000);
    }
    // Confirmed bookings that were refunded, cancelled or deleted in the meantime are not touched.
    const alreadyChanged = confirmed.size - bookings.length;
    return NextResponse.json({ success: true, date, affected: bookings.length, refunded: succeeded.length, emailsSent, succeeded, failed, alreadyChanged, message: `${succeeded.length} booking${succeeded.length === 1 ? '' : 's'} refunded, ${emailsSent} email${emailsSent === 1 ? '' : 's'} sent, ${failed.length} failed.${alreadyChanged > 0 ? ` ${alreadyChanged} had already been refunded or cancelled.` : ''}` });
  } catch (error) {
    if (error instanceof AdminAuthError) return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    console.error('Bulk voucher refund error', error);
    return NextResponse.json({ success: false, error: 'Could not process the date refund' }, { status: 500 });
  }
}
