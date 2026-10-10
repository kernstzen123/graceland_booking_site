import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

describe('holds on unpaid bookings made by staff', async () => {
  const { isOpenEndedHold, isStaffUnpaidBooking, STAFF_HOLD_UNTIL } = await import('@/lib/booking-holds');

  it('never run out: the booking keeps its places until an admin or manager deletes it', () => {
    expect(new Date(STAFF_HOLD_UNTIL).getTime()).toBeGreaterThan(new Date('2999-01-01T00:00:00Z').getTime());
    expect(isOpenEndedHold(STAFF_HOLD_UNTIL)).toBe(true);
    expect(isOpenEndedHold('2026-10-17T21:59:59.000Z')).toBe(false);
    expect(isOpenEndedHold(null)).toBe(false);
  });

  it('apply to Add booking bookings only, not to online bookings', () => {
    expect(isStaffUnpaidBooking({ sold_by: 'staff-user-id', payment_method: 'MANUAL_EFT' })).toBe(true);
    // The staff member's account was removed, but the booking is still an office booking.
    expect(isStaffUnpaidBooking({ sold_by: null, payment_method: 'MANUAL_EFT' })).toBe(true);
    // Online bookings waiting for EFT or PayFast have no payment method or seller yet.
    expect(isStaffUnpaidBooking({ sold_by: null, payment_method: null })).toBe(false);
  });
});
