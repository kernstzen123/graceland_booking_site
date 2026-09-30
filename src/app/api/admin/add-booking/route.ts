import { NextResponse } from 'next/server';
import { AdminAuthError, requireAdmin } from '@/lib/admin-auth';
import { createStaffBooking, OFFICE_PAYMENT_METHODS, prepareStaffBooking, StaffBookingError, type OfficePaymentKey } from '@/lib/staff-bookings';

/**
 * POST — a booking taken by staff (phone or office). Paid bookings get their
 * QR tickets emailed; unpaid ones get EFT payment instructions.
 * Body: { visitDate, customer, selections, party?, spotIds, notes?, payment: { method, reference? } | null, idempotencyKey }
 */
export async function POST(request: Request) {
  try {
    const { user } = await requireAdmin(request, ['ADMIN', 'MANAGER']);
    const body = await request.json();
    const payment = body?.payment ? { method: String(body.payment.method || '').toUpperCase() as OfficePaymentKey, reference: String(body.payment.reference || '') } : null;
    if (payment && !OFFICE_PAYMENT_METHODS[payment.method]) throw new StaffBookingError('Choose how the customer paid.');
    const prepared = await prepareStaffBooking({
      visitDate: body?.visitDate,
      customer: body?.customer || {},
      selections: body?.selections || {},
      party: body?.party,
      spotIds: Array.isArray(body?.spotIds) ? body.spotIds : [],
      notes: body?.notes,
    });
    if (body?.expectedTotal !== undefined && Math.abs(Number(body.expectedTotal) - prepared.total) > 0.01) {
      throw new StaffBookingError(`Prices have changed: the total is now R ${prepared.total.toFixed(2)}. Check it with the customer and submit again.`);
    }
    const key = typeof body?.idempotencyKey === 'string' && body.idempotencyKey.trim() ? `office-${body.idempotencyKey.trim().slice(0, 80)}` : null;
    const result = await createStaffBooking(prepared, { kind: 'OFFICE', actorId: user.id, idempotencyKey: key, payment });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    if (error instanceof AdminAuthError) return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    if (error instanceof StaffBookingError) return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    console.error('Add booking error', error);
    return NextResponse.json({ success: false, error: 'The booking could not be saved. Try again.' }, { status: 500 });
  }
}
