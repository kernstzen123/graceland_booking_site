import { NextResponse } from 'next/server';
import { AdminAuthError, requireAdmin, writeAudit } from '@/lib/admin-auth';
import { supabase } from '@/lib/supabase';
import { emailTicketsOnce } from '@/lib/ticketing';
import { recordNotificationFailure } from '@/lib/voucher-email';
import { FORCEABLE_FAILURES, setBookingPaymentStatus } from '@/lib/booking-holds';

/** Hours a customer gets to upload a new proof after one is rejected. */
const REUPLOAD_HOURS = 24;

export async function GET(request: Request) {
  try {
    await requireAdmin(request, ['ADMIN', 'MANAGER']);
    const status = new URL(request.url).searchParams.get('status') || 'PENDING';
    const { data, error } = await supabase
      .from('payment_proofs')
      .select('id, file_url, status, admin_notes, uploaded_at, verified_at, booking_id, bookings(id,reference,visit_date,total_amount,amount_due,status,expires_at,attention_reason,customers(first_name,last_name,email,phone),booking_items(quantity,subtotal,metadata,packages(name),huts(name)))')
      .eq('status', status.toUpperCase())
      .order('uploaded_at', { ascending: false });
    if (error) throw error;

    const now = Date.now();
    const proofs = await Promise.all((data || []).map(async proof => {
      const { data: signed } = await supabase.storage.from('payment-proofs').createSignedUrl(proof.file_url, 3600);
      const booking = Array.isArray(proof.bookings) ? proof.bookings[0] : proof.bookings;
      // The reservation lapsed before the proof could hold it: approving re-checks availability.
      const holdLapsed = Boolean(booking && ['UNPAID', 'PAYMENT_FAILED'].includes(booking.status) && (!booking.expires_at || new Date(booking.expires_at).getTime() <= now));
      return { ...proof, signed_url: signed?.signedUrl || null, hold_lapsed: holdLapsed };
    }));
    return NextResponse.json({ success: true, proofs });
  } catch (error) {
    if (error instanceof AdminAuthError) return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    console.error('Admin proofs error', error);
    return NextResponse.json({ success: false, error: 'Could not load payment proofs' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const { user, role } = await requireAdmin(request, ['ADMIN', 'MANAGER']);
    const { proofId, action, reason, force } = await request.json();
    if (!proofId || !['approve', 'reject'].includes(action)) return NextResponse.json({ success: false, error: 'Invalid proof action' }, { status: 400 });
    const note = typeof reason === 'string' ? reason.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 500) : '';

    const { data: proof, error: proofError } = await supabase
      .from('payment_proofs')
      .select('id, status, booking_id, bookings(id,reference,total_amount,amount_due,status,expires_at,visit_date,people_count,customers(first_name,last_name,email))')
      .eq('id', proofId).maybeSingle();
    if (proofError) throw proofError;
    if (!proof) return NextResponse.json({ success: false, error: 'Proof not found' }, { status: 404 });
    if (proof.status !== 'PENDING') return NextResponse.json({ success: false, error: `This proof has already been ${String(proof.status).toLowerCase()}.` }, { status: 409 });
    const booking = Array.isArray(proof.bookings) ? proof.bookings[0] : proof.bookings;
    if (!booking) return NextResponse.json({ success: false, error: 'Booking not found' }, { status: 404 });

    if (action === 'reject') {
      const { error: updateProofError } = await supabase.from('payment_proofs').update({
        status: 'REJECTED', admin_notes: note || null, verified_at: new Date().toISOString(), verified_by: user.id,
      }).eq('id', proofId).eq('status', 'PENDING');
      if (updateProofError) throw updateProofError;
      // A booking waiting on this proof goes back to unpaid with a short hold so
      // the customer can upload a new one. Its places were held all along
      // (PAYMENT_PENDING), so this does not revive anything. Bookings in any
      // other state are left alone, and so is a booking with another proof
      // still waiting for review.
      const { count: otherPending, error: countError } = await supabase.from('payment_proofs')
        .select('id', { count: 'exact', head: true }).eq('booking_id', booking.id).eq('status', 'PENDING');
      if (countError) throw countError;
      if (booking.status === 'PAYMENT_PENDING' && !otherPending) {
        const { error: bookingError } = await supabase.from('bookings').update({
          status: 'UNPAID',
          expires_at: new Date(Date.now() + REUPLOAD_HOURS * 60 * 60 * 1000).toISOString(),
        }).eq('id', booking.id).eq('status', 'PAYMENT_PENDING');
        if (bookingError) throw bookingError;
      }
      await writeAudit(user.id, 'REJECT_PROOF', 'payment_proof', proofId, { booking_id: booking.id, reference: booking.reference, reason: note || null });
      return NextResponse.json({ success: true, status: 'REJECTED' });
    }

    // --- APPROVE ---
    if (['PAID', 'CONFIRMED'].includes(booking.status)) {
      return NextResponse.json({ success: false, error: 'This booking is already paid or confirmed. Reject this proof if it is a duplicate.' }, { status: 409 });
    }
    if (['CANCELLED', 'REFUNDED'].includes(booking.status)) {
      return NextResponse.json({ success: false, error: 'This booking was cancelled, so it cannot be approved. Reject the proof and contact the customer about a refund or a new booking.' }, { status: 409 });
    }
    const forcing = force === true;
    if (forcing && role !== 'ADMIN') return NextResponse.json({ success: false, error: 'Only admins can force-approve a booking.' }, { status: 403 });

    // Marks the booking paid and records the payment in one transaction. If the
    // reservation lapsed, the day's capacity, the seating and any voucher are
    // re-checked under the booking locks first.
    const paymentAmount = Number(booking.amount_due ?? booking.total_amount);
    const result = await setBookingPaymentStatus(booking.id, 'PAID', {
      paymentMethod: 'MANUAL_EFT',
      force: forcing,
      payment: { amount: paymentAmount, reference: `EFT-${proof.id}` },
    });
    if (!result.ok) {
      const forceable = Boolean(result.reason && FORCEABLE_FAILURES.has(result.reason));
      return NextResponse.json({
        success: false,
        error: forceable
          ? `This booking's reservation expired and it can no longer be confirmed as booked: ${result.detail} An ADMIN can force-approve if needed.`
          : result.detail || 'This proof could not be approved.',
        capacityExceeded: forceable,
        canForce: forceable && role === 'ADMIN',
      }, { status: 409 });
    }

    const { error: updateProofError } = await supabase.from('payment_proofs').update({
      status: 'APPROVED', admin_notes: note || null, verified_at: new Date().toISOString(), verified_by: user.id,
    }).eq('id', proofId);
    if (updateProofError) throw updateProofError;
    const customer = Array.isArray(booking.customers) ? booking.customers[0] : booking.customers;

    let emailSent = true;
    try {
      await emailTicketsOnce(booking.id, customer?.email || '', [customer?.first_name, customer?.last_name].filter(Boolean).join(' ') || 'Customer');
    } catch (emailError) {
      // Keep booking PAID, record the failure, but don't fail the approval
      emailSent = false;
      console.error(`Ticket email failed after proof approval for ${booking.reference}`, emailError);
      await recordNotificationFailure('booking', 'TICKETS_EMAIL_FAILED', customer?.email || '', booking.id, emailError);
    }

    await writeAudit(user.id, 'APPROVE_PROOF', 'payment_proof', proofId, { booking_id: booking.id, reference: booking.reference, reason: note || null, force: forcing, hold_reclaimed: result.reclaimed });
    return NextResponse.json({
      success: true,
      status: 'APPROVED',
      emailSent,
      message: emailSent
        ? undefined
        : 'Booking approved and marked PAID, but the ticket email could not be sent. Use "Resend tickets" in the bookings page.',
    });
  } catch (error) {
    if (error instanceof AdminAuthError) return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    console.error('Admin proof action error', error);
    const message = error instanceof Error && error.message.includes('supabase/migrations/') ? error.message : 'Could not process proof';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
