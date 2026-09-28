import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { checkRateLimit, getClientAddress } from '@/lib/request-security';
import { EftEmailRefused, sendEftInstructions } from '@/lib/eft-email';
import { recordNotificationFailure } from '@/lib/mailer';

const GENERIC_ERROR = 'We could not send the payment instructions. Please check your booking reference and try again.';

export async function POST(request: Request) {
  let bookingId = '';
  try {
    const { reference } = await request.json();
    if (typeof reference !== 'string' || !reference.trim()) {
      return NextResponse.json({ success: false, error: 'Booking reference is required' }, { status: 400 });
    }
    const ref = reference.trim();

    // Rate-limit by booking reference (3 per 5 min) and by IP (5 per minute)
    const ip = getClientAddress(request);
    if (!(await checkRateLimit(request, 'eft-email-ref', 3, 300, ref))) {
      return NextResponse.json({ success: false, error: 'Too many requests. Please wait a moment and try again.' }, { status: 429 });
    }
    if (!(await checkRateLimit(request, 'eft-email-ip', 5, 60, ip))) {
      return NextResponse.json({ success: false, error: 'Too many requests. Please wait a moment and try again.' }, { status: 429 });
    }

    // The email only ever goes to the customer's own address on the booking.
    const { data: booking, error: bookingError } = await supabase.from('bookings').select('id, customers(email)').eq('reference', ref).maybeSingle();
    if (bookingError || !booking) return NextResponse.json({ success: false, error: GENERIC_ERROR }, { status: 400 });
    bookingId = booking.id;

    try {
      await sendEftInstructions(booking.id);
    } catch (sendError) {
      if (sendError instanceof EftEmailRefused) throw sendError;
      // The booking is held; staff can resend from Settings → Email retries.
      const customer = Array.isArray(booking.customers) ? booking.customers[0] : booking.customers;
      await recordNotificationFailure('booking', 'EFT_INSTRUCTIONS', customer?.email || '', booking.id, sendError);
      throw sendError;
    }
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    if (error instanceof EftEmailRefused) return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    console.error(`EFT email failed${bookingId ? ` for booking ${bookingId}` : ''}`, error);
    return NextResponse.json({ success: false, error: 'We could not send the payment instructions. Please try again or contact support.' }, { status: 500 });
  }
}
