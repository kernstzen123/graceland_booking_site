import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBookingQrToken, createQrToken } from '@/lib/qr-token';

const BOOKING = '11111111-1111-4111-8111-111111111111';

/** resolveScanCode against an in-memory copy of the tables it reads. */
async function resolveWith(tables: Record<string, Array<Record<string, unknown>>>, input: { token?: string; ticketUid?: string; reference?: string }) {
  vi.doMock('@/lib/supabase', () => ({
    supabase: {
      from: (table: string) => {
        const filters: Array<[string, unknown]> = [];
        const chain = {
          select: () => chain,
          eq: (column: string, value: unknown) => { filters.push([column, value]); return chain; },
          maybeSingle: () => Promise.resolve({ data: (tables[table] || []).find(row => filters.every(([column, value]) => row[column] === value)) || null, error: null }),
        };
        return chain;
      },
    },
  }));
  vi.resetModules();
  const { resolveScanCode } = await import('@/lib/booking-scan');
  return resolveScanCode(input);
}

afterEach(() => { vi.doUnmock('@/lib/supabase'); });

describe('QR codes already sent keep opening their booking', () => {
  const ticketToken = createQrToken(BOOKING, 'TKT-AAAA1111', '2099-12-31');
  const url = (token: string) => `https://www.gracelandvenuespaarl.co.za/admin/scanner?token=${encodeURIComponent(token)}`;

  it('the booking QR code', async () => {
    const token = createBookingQrToken(BOOKING, 'BK-2026-ABCD1234', '2099-12-31');
    expect(await resolveWith({ bookings: [{ id: BOOKING, qr_token: token }] }, { token: url(token) })).toEqual({ bookingId: BOOKING });
  });

  it('an older per-person ticket QR code (from before one QR per booking)', async () => {
    expect(await resolveWith({ tickets: [{ booking_id: BOOKING, ticket_uid: 'TKT-AAAA1111', qr_token: ticketToken }] }, { token: url(ticketToken) })).toEqual({ bookingId: BOOKING });
  });

  it('a ticket code whose ticket was replaced when staff edited the booking', async () => {
    expect(await resolveWith({ tickets: [], bookings: [{ id: BOOKING, qr_token: null }] }, { token: url(ticketToken) })).toEqual({ bookingId: BOOKING });
  });

  it('a ticket code signed for an older visit date (the booking was moved)', async () => {
    const oldDate = createQrToken(BOOKING, 'TKT-AAAA1111', '2020-01-01');
    expect(await resolveWith({ tickets: [], bookings: [{ id: BOOKING }] }, { token: url(oldDate) })).toEqual({ bookingId: BOOKING });
  });

  it('a ticket ID or booking reference typed in', async () => {
    expect(await resolveWith({ tickets: [{ booking_id: BOOKING, ticket_uid: 'TKT-AAAA1111' }] }, { ticketUid: 'tkt-aaaa1111' })).toEqual({ bookingId: BOOKING });
    expect(await resolveWith({ bookings: [{ id: BOOKING, reference: 'BK-2026-ABCD1234' }] }, { reference: 'bk-2026-abcd1234' })).toEqual({ bookingId: BOOKING });
  });

  it('meal vouchers still go to the kitchen redemption', async () => {
    const meal = createQrToken(BOOKING, 'MEAL-AB12', '2099-12-31', 'meal');
    expect(await resolveWith({}, { token: url(meal) })).toEqual({ mealUid: 'MEAL-AB12' });
  });

  it('a forged or altered code is refused', async () => {
    const [payload, signature] = ticketToken.split('.');
    const otherBooking = Buffer.from(Buffer.from(payload, 'base64url').toString().replace(BOOKING, '22222222-2222-4222-8222-222222222222')).toString('base64url');
    expect(await resolveWith({ bookings: [{ id: '22222222-2222-4222-8222-222222222222' }] }, { token: `${otherBooking}.${signature}` })).toEqual({ error: 'This QR code is not valid.' });
  });

  it('a code for a booking that no longer exists says so', async () => {
    expect(await resolveWith({ tickets: [], bookings: [] }, { token: ticketToken })).toEqual({ error: 'Booking not found.' });
  });
});
