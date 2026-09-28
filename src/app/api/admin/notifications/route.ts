import { NextResponse } from 'next/server';
import { AdminAuthError, requireAdmin, writeAudit } from '@/lib/admin-auth';
import { supabase } from '@/lib/supabase';
import { sendVoucherEmail } from '@/lib/voucher-email';
import { generateTicketsAndSendEmail } from '@/lib/ticketing';
import { EftEmailRefused, sendEftInstructions } from '@/lib/eft-email';
import { sendStaffSetupLink, StaffInviteError } from '@/lib/staff-invite';

/** Every email type that can fail, and what "Retry" sends again. */
const TICKET_TYPES = new Set(['TICKETS_EMAIL_FAILED', 'TICKETS_ISSUED_BY_VOUCHER', 'WALK_IN_TICKETS']);
const RETRYABLE = new Set(['VOUCHER_ISSUED', 'EFT_INSTRUCTIONS', 'STAFF_INVITE', ...TICKET_TYPES]);

class RetryRefused extends Error {}

export async function GET(request: Request) {
  try {
    await requireAdmin(request, ['ADMIN', 'MANAGER']);
    const { data, error } = await supabase.from('notification_failures').select('id,notification_type,recipient,entity_id,error_message,attempts,created_at').is('resolved_at', null).order('created_at', { ascending: false }).limit(100);
    if (error) throw error;
    return NextResponse.json({ success: true, failures: (data || []).map(failure => ({ ...failure, retryable: RETRYABLE.has(failure.notification_type) })) });
  } catch (error) {
    if (error instanceof AdminAuthError) return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    console.error('Notification failure list error', error);
    return NextResponse.json({ success: false, error: 'Could not load failed notifications' }, { status: 500 });
  }
}

async function resendVoucher(creditId: string) {
  const { data: credit, error } = await supabase.from('booking_credits').select('id,credit_code,original_amount,paid_amount,deduction_percentage,issue_reason,bookings!booking_credits_original_booking_id_fkey(reference,visit_date,customers(first_name,last_name,email))').eq('id', creditId).maybeSingle();
  if (error) throw error;
  if (!credit) throw new RetryRefused('The voucher for this email could not be found');
  const booking = Array.isArray(credit.bookings) ? credit.bookings[0] : credit.bookings;
  const customer = booking && (Array.isArray(booking.customers) ? booking.customers[0] : booking.customers);
  await sendVoucherEmail({
    bookingReference: booking?.reference || '', visitDate: booking?.visit_date || '', customerEmail: customer?.email || '',
    customerName: customer ? `${customer.first_name} ${customer.last_name}` : 'Customer', creditCode: credit.credit_code,
    originalAmount: Number(credit.original_amount), paidAmount: credit.paid_amount === null ? null : Number(credit.paid_amount),
    deductionPercentage: Number(credit.deduction_percentage || 0), reason: credit.issue_reason,
  });
  return { credit_id: credit.id, credit_code: credit.credit_code };
}

async function resendTickets(bookingId: string) {
  const { data: booking, error } = await supabase.from('bookings').select('id,reference,status,customers(first_name,last_name,email)').eq('id', bookingId).maybeSingle();
  if (error) throw error;
  if (!booking) throw new RetryRefused('The booking for this email could not be found');
  if (!['PAID', 'CONFIRMED'].includes(booking.status)) throw new RetryRefused('This booking is no longer paid, so its tickets are not valid. Mark this email as resolved.');
  const customer = Array.isArray(booking.customers) ? booking.customers[0] : booking.customers;
  if (!customer?.email) throw new RetryRefused('The booking has no customer email address');
  await generateTicketsAndSendEmail(booking.id, customer.email, [customer.first_name, customer.last_name].filter(Boolean).join(' ') || 'Customer');
  return { reference: booking.reference };
}

/**
 * POST { failureId } — send the email again.
 * POST { failureId, action: 'dismiss' } — mark it resolved without sending (e.g. no longer relevant).
 */
export async function POST(request: Request) {
  try {
    const { user } = await requireAdmin(request, ['ADMIN', 'MANAGER']);
    const { failureId, action } = await request.json();
    const { data: failure, error: failureError } = await supabase.from('notification_failures').select('id,notification_type,entity_id,attempts').eq('id', failureId).is('resolved_at', null).maybeSingle();
    if (failureError) throw failureError;
    if (!failure) return NextResponse.json({ success: false, error: 'Notification failure not found' }, { status: 404 });

    if (action === 'dismiss') {
      await supabase.from('notification_failures').update({ resolved_at: new Date().toISOString() }).eq('id', failure.id);
      await writeAudit(user.id, 'DISMISS_EMAIL_FAILURE', 'notification_failure', failure.id, { type: failure.notification_type, entity_id: failure.entity_id });
      return NextResponse.json({ success: true, message: 'Marked as resolved' });
    }
    if (!RETRYABLE.has(failure.notification_type)) return NextResponse.json({ success: false, error: 'This email type cannot be retried here. Mark it as resolved once handled.' }, { status: 400 });

    try {
      let details: Record<string, unknown> = {};
      if (failure.notification_type === 'VOUCHER_ISSUED') details = await resendVoucher(failure.entity_id);
      else if (TICKET_TYPES.has(failure.notification_type)) details = await resendTickets(failure.entity_id);
      else if (failure.notification_type === 'EFT_INSTRUCTIONS') await sendEftInstructions(failure.entity_id);
      else if (failure.notification_type === 'STAFF_INVITE') details = { email: (await sendStaffSetupLink(failure.entity_id)).email };
      await supabase.from('notification_failures').update({ resolved_at: new Date().toISOString(), attempts: Number(failure.attempts || 0) + 1 }).eq('id', failure.id);
      await writeAudit(user.id, 'RETRY_EMAIL', 'notification_failure', failure.id, { type: failure.notification_type, entity_id: failure.entity_id, ...details });
      return NextResponse.json({ success: true, message: 'Email sent successfully' });
    } catch (sendError) {
      if (sendError instanceof RetryRefused || sendError instanceof EftEmailRefused || sendError instanceof StaffInviteError) {
        return NextResponse.json({ success: false, error: sendError.message }, { status: 409 });
      }
      console.error('Email retry failed', sendError);
      await supabase.from('notification_failures').update({ attempts: Number(failure.attempts || 0) + 1, error_message: sendError instanceof Error ? sendError.message.slice(0, 1000) : 'Email retry failed' }).eq('id', failure.id);
      return NextResponse.json({ success: false, error: 'Email retry failed. The failure remains queued.' }, { status: 502 });
    }
  } catch (error) {
    if (error instanceof AdminAuthError) return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    console.error('Notification retry error', error);
    return NextResponse.json({ success: false, error: 'Could not retry notification' }, { status: 500 });
  }
}
