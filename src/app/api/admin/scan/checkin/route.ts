import { NextResponse } from 'next/server';
import { AdminAuthError, requireAdmin, writeAudit } from '@/lib/admin-auth';
import { checkRateLimit, cleanText } from '@/lib/request-security';
import { checkInBooking, ensureBookingTickets, loadBookingCard } from '@/lib/booking-scan';

/**
 * POST { bookingId, count, deviceId? } — check in `count` people on a booking
 * (the whole group or part of it; the rest can be checked in later with the
 * same QR code). Unpaid bookings that still hold their places can be checked
 * in: the scanner shows a NOT PAID warning, and the audit log records it.
 */
export async function POST(request: Request) {
  try {
    const { user } = await requireAdmin(request, ['ADMIN', 'MANAGER', 'SCANNER']);
    if (!(await checkRateLimit(request, 'admin-scan-checkin', 120, 60, user.id))) return NextResponse.json({ success: false, error: 'Too many check-ins. Please wait a moment and try again.' }, { status: 429 });
    const body = await request.json().catch(() => ({}));
    const bookingId = cleanText(body.bookingId, 80);
    const count = Number(body.count);
    const deviceId = cleanText(body.deviceId, 80) || null;
    if (!/^[0-9a-f-]{36}$/i.test(bookingId)) return NextResponse.json({ success: false, error: 'Booking not found.' }, { status: 400 });
    if (!Number.isInteger(count) || count < 1 || count > 500) return NextResponse.json({ success: false, error: 'Choose how many people to check in.' }, { status: 400 });

    // An unpaid booking staff added before booking QR codes existed may have no tickets yet.
    await ensureBookingTickets(bookingId);
    const result = await checkInBooking(bookingId, count, user.id, deviceId);
    // Once people are checked in, the answer must say so even if the refreshed card cannot be loaded,
    // or the scanner could check them in a second time on its own.
    let found: Awaited<ReturnType<typeof loadBookingCard>> = null;
    try { found = await loadBookingCard(bookingId); } catch (cardError) { console.error('Could not reload the booking card after check-in', bookingId, cardError); }
    if (result.ok) {
      await writeAudit(user.id, 'CHECK_IN_BOOKING', 'booking', bookingId, {
        reference: found?.card.reference, checked_in: result.checkedIn.length, tickets: result.checkedIn,
        checked_in_total: result.used, people: result.total, device_id: deviceId,
        ...(found?.card.unpaid ? { unpaid: true, owing: found.card.owing } : {}),
      });
    }
    return NextResponse.json({
      success: result.ok,
      ...(result.ok ? {} : { reason: result.reason, error: result.detail || 'Could not check in this booking.' }),
      checkedIn: result.checkedIn,
      used: result.used,
      total: result.total,
      booking: found?.card || null,
      lastCheckInAt: found?.lastCheckInAt || null,
    });
  } catch (error) {
    if (error instanceof AdminAuthError) return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    console.error('Booking check-in error', error);
    const message = error instanceof Error && error.message.includes('supabase/migrations/') ? error.message : 'Could not check in this booking. Try again.';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
