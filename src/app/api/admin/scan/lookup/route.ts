import { NextResponse } from 'next/server';
import { AdminAuthError, requireAdmin } from '@/lib/admin-auth';
import { checkRateLimit, cleanText } from '@/lib/request-security';
import { loadBookingCard, resolveScanCode } from '@/lib/booking-scan';

/**
 * POST { token?, ticketUid?, reference? } — the booking behind a scanned QR code
 * (the booking's own code or an older per-person ticket code), a ticket ID or a
 * booking reference, as the gate scanner's booking card. Nothing is checked in.
 * A meal voucher answers { mealUid } so the scanner redeems it as before.
 */
export async function POST(request: Request) {
  try {
    const { user } = await requireAdmin(request, ['ADMIN', 'MANAGER', 'SCANNER']);
    if (!(await checkRateLimit(request, 'admin-scan-lookup', 120, 60, user.id))) return NextResponse.json({ success: false, error: 'Too many scans. Please wait a moment and scan again.' }, { status: 429 });
    const body = await request.json().catch(() => ({}));
    const target = await resolveScanCode({ token: cleanText(body.token, 1000), ticketUid: cleanText(body.ticketUid, 80), reference: cleanText(body.reference, 80) });
    if ('error' in target) return NextResponse.json({ success: false, error: target.error });
    if ('mealUid' in target) return NextResponse.json({ success: true, mealUid: target.mealUid });
    const found = await loadBookingCard(target.bookingId);
    if (!found) return NextResponse.json({ success: false, error: 'Booking not found.' });
    return NextResponse.json({ success: true, booking: found.card, lastCheckInAt: found.lastCheckInAt });
  } catch (error) {
    if (error instanceof AdminAuthError) return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    console.error('Scanner lookup error', error);
    return NextResponse.json({ success: false, error: 'Could not look up this booking. Try again.' }, { status: 500 });
  }
}
