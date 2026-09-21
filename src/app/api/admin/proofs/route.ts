import { NextResponse } from 'next/server';
import { AdminAuthError, requireAdmin, writeAudit } from '@/lib/admin-auth';
import { supabase } from '@/lib/supabase';
import { generateTicketsAndSendEmail } from '@/lib/ticketing';
import { recordNotificationFailure } from '@/lib/voucher-email';

export async function GET(request: Request) {
  try {
    await requireAdmin(request, ['ADMIN', 'MANAGER']);
    const status = new URL(request.url).searchParams.get('status') || 'PENDING';
    const { data, error } = await supabase
      .from('payment_proofs')
      .select('id, file_url, status, admin_notes, uploaded_at, verified_at, booking_id, bookings(id,reference,visit_date,total_amount,amount_due,status,expires_at,customers(first_name,last_name,email,phone),booking_items(quantity,subtotal,metadata,packages(name),huts(name)))')
      .eq('status', status.toUpperCase())
      .order('uploaded_at', { ascending: false });
    if (error) throw error;

    const proofs = await Promise.all((data || []).map(async proof => {
      const { data: signed } = await supabase.storage.from('payment-proofs').createSignedUrl(proof.file_url, 3600);
      return { ...proof, signed_url: signed?.signedUrl || null };
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

    const { data: proof, error: proofError } = await supabase
      .from('payment_proofs')
      .select('id, booking_id, bookings(id,reference,total_amount,amount_due,status,expires_at,visit_date,people_count,customers(first_name,last_name,email),booking_items(quantity,metadata,packages(name),huts(name)))')
      .eq('id', proofId).single();
    if (proofError || !proof) throw new Error('Proof not found');
    const booking = Array.isArray(proof.bookings) ? proof.bookings[0] : proof.bookings;
    if (!booking) throw new Error('Booking not found');

    if (action === 'reject') {
      const { error: updateProofError } = await supabase.from('payment_proofs').update({
        status: 'REJECTED', admin_notes: reason || null, verified_at: new Date().toISOString(), verified_by: user.id,
      }).eq('id', proofId);
      if (updateProofError) throw updateProofError;
      // Give the customer 24 hours to re-upload proof
      await supabase.from('bookings').update({
        status: 'UNPAID',
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      }).eq('id', booking.id);
      await writeAudit(user.id, 'REJECT_PROOF', 'payment_proof', proofId, { booking_id: booking.id, reason: reason || null });
      return NextResponse.json({ success: true, status: 'REJECTED' });
    }

    // --- APPROVE ---

    // Refuse if already PAID or CONFIRMED (no duplicate payment)
    if (['PAID', 'CONFIRMED'].includes(booking.status)) {
      return NextResponse.json({ success: false, error: 'This booking is already paid or confirmed. No further action is needed.' }, { status: 409 });
    }

    // If the hold has lapsed (UNPAID and expires_at in the past), check capacity
    const holdLapsed = booking.status === 'UNPAID' && booking.expires_at && new Date(booking.expires_at).getTime() <= Date.now();
    if (holdLapsed) {
      const { data: capacityOk, error: capacityError } = await supabase.rpc('recheck_capacity_for_approval', { p_booking_id: booking.id });
      if (capacityError) throw capacityError;
      if (!capacityOk) {
        if (force === true && role === 'ADMIN') {
          // Admin explicitly forcing approval on a full day
          console.warn(`Admin ${user.id} force-approving booking ${booking.reference} despite capacity exceeded`);
        } else {
          return NextResponse.json({
            success: false,
            error: 'This booking\'s hold has expired and the day is now full. An ADMIN can force-approve if needed.',
            capacityExceeded: true,
          }, { status: 409 });
        }
      }
    }

    const { error: updateProofError } = await supabase.from('payment_proofs').update({
      status: 'APPROVED', admin_notes: reason || null, verified_at: new Date().toISOString(), verified_by: user.id,
    }).eq('id', proofId);
    if (updateProofError) throw updateProofError;

    const { error: bookingError } = await supabase.from('bookings').update({ status: 'PAID', payment_method: 'MANUAL_EFT' }).eq('id', booking.id);
    if (bookingError) throw bookingError;
    const paymentAmount = Number(booking.amount_due ?? booking.total_amount);
    const { error: paymentError } = await supabase.from('payments').insert({ booking_id: booking.id, amount: paymentAmount, method: 'MANUAL_EFT', status: 'COMPLETE', provider_reference: `EFT-${proof.id}` });
    if (paymentError) throw paymentError;
    const customer = Array.isArray(booking.customers) ? booking.customers[0] : booking.customers;

    let emailSent = true;
    try {
      await generateTicketsAndSendEmail(booking.id, customer?.email || '', [customer?.first_name, customer?.last_name].filter(Boolean).join(' ') || 'Customer');
    } catch (emailError) {
      // Keep booking PAID, record the failure, but don't fail the approval
      emailSent = false;
      console.error(`Ticket email failed after proof approval for ${booking.reference}`, emailError);
      await recordNotificationFailure('booking', 'TICKETS_EMAIL_FAILED', customer?.email || '', booking.id, emailError);
    }

    await writeAudit(user.id, 'APPROVE_PROOF', 'payment_proof', proofId, { booking_id: booking.id, reason: reason || null, force: force === true });
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
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Could not process proof' }, { status: 500 });
  }
}
