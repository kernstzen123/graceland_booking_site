import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

describe('holds on unpaid bookings made by staff', async () => {
  const { isStaffUnpaidBooking, staffHoldUntil } = await import('@/lib/booking-holds');

  it('last until the end of the visit day in South Africa', () => {
    expect(staffHoldUntil('2026-10-17')).toBe('2026-10-17T21:59:59.000Z');
  });

  it('apply to Add booking bookings only, not to online bookings', () => {
    expect(isStaffUnpaidBooking({ sold_by: 'staff-user-id', payment_method: 'MANUAL_EFT' })).toBe(true);
    // The staff member's account was removed, but the booking is still an office booking.
    expect(isStaffUnpaidBooking({ sold_by: null, payment_method: 'MANUAL_EFT' })).toBe(true);
    // Online bookings waiting for EFT or PayFast have no payment method or seller yet.
    expect(isStaffUnpaidBooking({ sold_by: null, payment_method: null })).toBe(false);
  });
});
