import { NextResponse } from 'next/server';
import { AdminAuthError, requireAdmin, writeAudit } from '@/lib/admin-auth';
import { supabase } from '@/lib/supabase';
import { generateTicketsAndSendEmail } from '@/lib/ticketing';

export async function GET(request: Request) {
  try {
    await requireAdmin(request, ['ADMIN', 'MANAGER']);
    const status = new URL(request.url).searchParams.get('status') || 'PENDING';
    const { data, error } = await supabase
      .from('payment_proofs')
      .select('id, file_url, status, admin_notes, uploaded_at, verified_at, booking_id, bookings(id,reference,visit_date,total_amount,status,customers(first_name,last_name,email,phone),booking_items(quantity,metadata,packages(name),huts(name)))')
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
    const { user } = await requireAdmin(request, ['ADMIN', 'MANAGER']);
    const { proofId, action, reason } = await request.json();
    if (!proofId || !['approve', 'reject'].includes(action)) return NextResponse.json({ success: false, error: 'Invalid proof action' }, { status: 400 });

    const { data: proof, error: proofError } = await supabase
      .from('payment_proofs')
      .select('id, booking_id, bookings(id,reference,total_amount,status,customers(first_name,last_name,email),booking_items(quantity,metadata,packages(name),huts(name)))')
      .eq('id', proofId).single();
    if (proofError || !proof) throw new Error('Proof not found');
    const booking = Array.isArray(proof.bookings) ? proof.bookings[0] : proof.bookings;
    if (!booking) throw new Error('Booking not found');

    const nextStatus = action === 'approve' ? 'APPROVED' : 'REJECTED';
    const { error: updateProofError } = await supabase.from('payment_proofs').update({
      status: nextStatus, admin_notes: reason || null, verified_at: new Date().toISOString(), verified_by: user.id,
    }).eq('id', proofId);
    if (updateProofError) throw updateProofError;

    if (action === 'approve') {
      const { error: bookingError } = await supabase.from('bookings').update({ status: 'PAID', payment_method: 'MANUAL_EFT' }).eq('id', booking.id);
      if (bookingError) throw bookingError;
      const { error: paymentError } = await supabase.from('payments').insert({ booking_id: booking.id, amount: booking.total_amount, method: 'MANUAL_EFT', status: 'COMPLETE', provider_reference: `EFT-${proof.id}` });
      if (paymentError) throw paymentError;
      const customer = Array.isArray(booking.customers) ? booking.customers[0] : booking.customers;
      await generateTicketsAndSendEmail(booking.id, customer?.email || '', [customer?.first_name, customer?.last_name].filter(Boolean).join(' ') || 'Customer');
    }
    await writeAudit(user.id, action === 'approve' ? 'APPROVE_PROOF' : 'REJECT_PROOF', 'payment_proof', proofId, { booking_id: booking.id, reason: reason || null });
    return NextResponse.json({ success: true, status: nextStatus });
  } catch (error) {
    if (error instanceof AdminAuthError) return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    console.error('Admin proof action error', error);
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Could not process proof' }, { status: 500 });
  }
}
