import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import crypto from 'crypto';
import { customerError } from '@/lib/public-errors';

const MAX_PROOF_SIZE = 10 * 1024 * 1024;

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const reference = formData.get('reference') as string;
    const file = formData.get('file') as File;

    if (!reference || !file) {
      return NextResponse.json({ success: false, error: 'Missing reference or file' }, { status: 400 });
    }

    const { data: booking, error: bookingError } = await supabase
      .from('bookings')
      .select('id,status')
      .eq('reference', reference)
      .single();
    if (bookingError || !booking) throw new Error('Booking not found');
    if (booking.status === 'PAID' || booking.status === 'CONFIRMED') throw new Error('This booking is already paid');
    const extension = file.name.split('.').pop()?.toLowerCase() || '';
    if (file.size > MAX_PROOF_SIZE) return NextResponse.json({ success: false, error: 'File must be 10 MB or smaller' }, { status: 400 });
    if (!['pdf', 'jpg', 'jpeg', 'png'].includes(extension)) return NextResponse.json({ success: false, error: 'Only PDF, JPG, and PNG files are allowed' }, { status: 400 });
    const fileBytes = Buffer.from(await file.arrayBuffer());
    const isPdf = fileBytes.subarray(0, 5).toString() === '%PDF-';
    const isJpeg = fileBytes.length >= 3 && fileBytes[0] === 0xff && fileBytes[1] === 0xd8 && fileBytes[2] === 0xff;
    const isPng = fileBytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if (!isPdf && !isJpeg && !isPng) return NextResponse.json({ success: false, error: 'The uploaded file is not a valid PDF, JPG, or PNG' }, { status: 400 });
    const contentType = isPdf ? 'application/pdf' : isJpeg ? 'image/jpeg' : 'image/png';
    const fileName = `${reference}/${crypto.randomUUID()}.${extension}`;
    const { data: uploadData, error: uploadError } = await supabase.storage.from('payment-proofs')
      .upload(fileName, fileBytes, { contentType, upsert: false });
    if (uploadError || !uploadData) throw uploadError || new Error('Could not upload proof');

    const { error: insertError } = await supabase
      .from('payment_proofs')
      .insert({ booking_id: booking.id, file_url: uploadData.path, status: 'PENDING' });
    if (insertError) throw insertError;
    // Hold the booking in PAYMENT_PENDING so capacity and seating are not released
    // while staff review the proof. The capacity/seating queries always count
    // PAYMENT_PENDING bookings regardless of expires_at.
    if (booking.status === 'UNPAID') {
      await supabase.from('bookings').update({ status: 'PAYMENT_PENDING' }).eq('id', booking.id);
    }
    return NextResponse.json({ success: true, message: 'Uploaded successfully' });
  } catch (error: unknown) {
    console.error('Proof upload failed', error);
    return NextResponse.json({ success: false, error: customerError(error, 'We could not upload your proof. Please try again or contact support.') }, { status: 500 });
  }
}
