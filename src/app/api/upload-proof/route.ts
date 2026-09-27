import crypto from 'crypto';
import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { checkRateLimit } from '@/lib/request-security';
import { flagBookingForReview, setBookingPaymentStatus, type HoldFailure } from '@/lib/booking-holds';

/**
 * Proof-of-payment upload, in two steps so large files never pass through this
 * server (Vercel rejects request bodies over 4.5 MB):
 *
 * 1. POST { action: 'start', reference, fileName, fileSize }
 *    → { path, token }: a one-time signed URL for uploading straight to the
 *    private payment-proofs bucket (which itself only accepts PDF/JPG/PNG up to 10 MB).
 * 2. The browser uploads the file with that token.
 * 3. POST { action: 'complete', reference, path }
 *    → the server checks the stored file really is a PDF, JPG or PNG, records it
 *    and moves the booking to PAYMENT_PENDING.
 */

const BUCKET = 'payment-proofs';
const MAX_PROOF_SIZE = 10 * 1024 * 1024;
/** Proofs a single booking may have (any status). More than this needs staff help. */
const MAX_PROOFS_PER_BOOKING = 5;
const CONTENT_TYPES: Record<string, string> = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };
const TOO_MANY = 'Too many requests. Please wait a moment and try again.';
const NOT_FOUND = 'We could not find a booking with that reference. Please check it and try again.';
/** Why a proof that arrived after the reservation lapsed could not hold the booking again. */
const LATE_PROOF_MESSAGES: Partial<Record<HoldFailure, string>> = {
  FULL: 'Your reservation had expired and the date has since filled up.',
  SEAT_TAKEN: 'Your reservation had expired and your hut or table has since been booked by someone else.',
  VOUCHER_UNAVAILABLE: 'Your reservation had expired and the voucher balance it used is no longer available.',
  DATE_PASSED: 'The visit date for this booking has already passed.',
  DATE_CLOSED: 'Graceland is closed on the date of this booking.',
};

class UploadError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

function extensionOf(fileName: unknown) {
  return typeof fileName === 'string' ? fileName.split('.').pop()?.toLowerCase() || '' : '';
}

/** The stored file's real type from its first bytes, or null if it is not a PDF, JPEG or PNG. */
function sniffContentType(bytes: Buffer) {
  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  return null;
}

/** The booking a customer is uploading for, if it can still take a proof. */
async function findBooking(reference: string) {
  const { data: booking, error } = await supabase.from('bookings').select('id,reference,status,visit_date,deleted_at').eq('reference', reference).maybeSingle();
  if (error) throw error;
  if (!booking) throw new UploadError(NOT_FOUND, 404);
  if (['PAID', 'CONFIRMED'].includes(booking.status)) throw new UploadError('This booking is already paid');
  if (booking.deleted_at || ['CANCELLED', 'REFUNDED'].includes(booking.status)) {
    throw new UploadError('This booking has been cancelled. Please contact us if you have already paid.', 409);
  }
  return booking;
}

async function removeUpload(path: string) {
  const { error } = await supabase.storage.from(BUCKET).remove([path]);
  if (error) console.error('Could not remove rejected proof upload', path, error);
}

export async function POST(request: Request) {
  try {
    if (!request.headers.get('content-type')?.includes('application/json')) {
      throw new UploadError('Please refresh the page and try again.');
    }
    const body = await request.json();
    const action = body?.action;
    const reference = typeof body?.reference === 'string' ? body.reference.trim().toUpperCase() : '';
    if (!reference || reference.length > 40 || !/^[A-Z0-9-]+$/.test(reference)) throw new UploadError('Please enter your booking reference.');

    if (action === 'start') {
      if (!(await checkRateLimit(request, 'proof-upload-start', 10, 600))) throw new UploadError(TOO_MANY, 429);
      if (!(await checkRateLimit(request, 'proof-upload-start-ref', 5, 600, reference))) throw new UploadError(TOO_MANY, 429);
      const extension = extensionOf(body.fileName);
      const size = Number(body.fileSize);
      if (!CONTENT_TYPES[extension]) throw new UploadError('Only PDF, JPG, and PNG files are allowed');
      if (!Number.isFinite(size) || size <= 0) throw new UploadError('The selected file is empty. Please choose another file.');
      if (size > MAX_PROOF_SIZE) throw new UploadError('File must be 10 MB or smaller');

      const booking = await findBooking(reference);
      const { count, error: countError } = await supabase.from('payment_proofs').select('id', { count: 'exact', head: true }).eq('booking_id', booking.id);
      if (countError) throw countError;
      if ((count || 0) >= MAX_PROOFS_PER_BOOKING) throw new UploadError('This booking already has several proofs of payment. Please contact us so we can help.', 409);

      const path = `${booking.reference}/${crypto.randomUUID()}.${extension}`;
      const { data: signed, error: signError } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path);
      if (signError || !signed) throw signError || new Error('Could not create upload URL');
      return NextResponse.json({ success: true, path: signed.path, token: signed.token, contentType: CONTENT_TYPES[extension] });
    }

    if (action === 'complete') {
      if (!(await checkRateLimit(request, 'proof-upload-complete', 20, 600))) throw new UploadError(TOO_MANY, 429);
      const path = typeof body.path === 'string' ? body.path : '';
      const booking = await findBooking(reference);
      const match = /^([A-Z0-9-]+)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|jpe?g|png)$/.exec(path);
      if (!match || match[1] !== booking.reference) throw new UploadError('The upload could not be matched to your booking. Please try again.');

      // A retry of this step (e.g. after a network error) finds the proof already recorded.
      const { data: existing, error: existingError } = await supabase.from('payment_proofs').select('id').eq('file_url', path).maybeSingle();
      if (existingError) throw existingError;
      if (!existing) {
        const { data: file, error: downloadError } = await supabase.storage.from(BUCKET).download(path);
        if (downloadError || !file) throw new UploadError('We did not receive your file. Please try uploading it again.');
        const bytes = Buffer.from(await file.arrayBuffer());
        const sniffed = sniffContentType(bytes);
        const declared = CONTENT_TYPES[match[2]];
        if (bytes.length === 0 || bytes.length > MAX_PROOF_SIZE || !sniffed || sniffed !== declared) {
          await removeUpload(path);
          throw new UploadError(bytes.length > MAX_PROOF_SIZE ? 'File must be 10 MB or smaller' : 'The uploaded file is not a valid PDF, JPG, or PNG');
        }
        const { error: insertError } = await supabase.from('payment_proofs').insert({ booking_id: booking.id, file_url: path, status: 'PENDING' });
        if (insertError && insertError.code !== '23505') throw insertError;
      }
      if (booking.status === 'PAYMENT_PENDING') return NextResponse.json({ success: true, message: 'Uploaded successfully' });

      // Hold the booking in PAYMENT_PENDING while staff review the proof. If the
      // reservation had lapsed, it is only revived when the date, seating and
      // voucher are all still available; otherwise staff are asked to follow up.
      const result = await setBookingPaymentStatus(booking.id, 'PAYMENT_PENDING');
      // ALREADY_PAID: paid another way meanwhile (e.g. PayFast); staff reject the duplicate proof.
      if (!result.ok && result.reason !== 'ALREADY_PAID') {
        await flagBookingForReview(booking.id, `A proof of payment was uploaded, but the booking's reservation had lapsed and could not be held again: ${result.detail} Check the payment, then either mark the booking paid (admins can override) or refund the customer.`);
        return NextResponse.json({
          success: true,
          reviewNeeded: true,
          message: `We've received your proof of payment. ${(result.reason && LATE_PROOF_MESSAGES[result.reason]) || 'Your reservation had expired.'} Our team will contact you to arrange another date or a refund.`,
        });
      }
      return NextResponse.json({ success: true, message: 'Uploaded successfully' });
    }

    throw new UploadError('Please refresh the page and try again.');
  } catch (error) {
    if (error instanceof UploadError) return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    console.error('Proof upload failed', error);
    return NextResponse.json({ success: false, error: 'We could not upload your proof. Please try again or contact support.' }, { status: 500 });
  }
}
