import { describe, expect, it, vi } from 'vitest';
import type { ReportData } from '@/lib/reports';

// reports.ts reads Supabase only in buildReport; assembleReport is pure.
vi.mock('@/lib/supabase', () => ({ supabase: {} }));

const booking = (reference: string, payment_method: string, total: number, created_at: string, visit_date = '2026-10-10') => ({
  id: reference, reference, visit_date, created_at, status: 'PAID', payment_method,
  total_amount: total, amount_due: total, voucher_amount_used: 0, people_count: 2,
  party_slot: null, expires_at: null, voucher_issued: false,
  first_name: 'A', last_name: 'B', email: `${reference.toLowerCase()}@example.com`, phone: '0820000000',
  tickets_issued: 2, tickets_used: 0, items_summary: '2× Adult', party_children: 0, party_option: null, party_packs: 0,
});

const data: ReportData = {
  bookings: [
    booking('BK-ONLINE', 'PAYFAST', 500, '2026-10-08T08:00:00Z'),
    booking('BK-OFFICE', 'OFFICE_CASH', 400, '2026-10-09T08:00:00Z'),
    booking('WI-GATE', 'GATE_CARD', 300, '2026-10-10T08:00:00Z'),
    // Imported on 5 October for a visit on the 10th: its creation time says nothing about when the customer booked.
    booking('IM-BOOK', 'IMPORTED', 1000, '2026-10-05T08:00:00Z'),
  ],
  items: [],
  previous: { started: 0, paid: 0, revenue: 0, collected: 0, visitors: 0 },
  returningEmails: [],
  seating: null,
  vouchers: { issuedCount: 0, issuedValue: 0, voidCount: 0, voidValue: 0, redeemedCount: 0, redeemedValue: 0, outstandingCount: 0, outstandingValue: 0 },
  capacity: 500,
};

describe('imported (booking book) bookings in reports', async () => {
  const { assembleReport } = await import('@/lib/reports');
  const report = assembleReport(data, '2026-10-10', '2026-10-10', 'visit', new Map(), '2026-10-07');
  const kpi = (label: string) => report.kpis.find(k => k.label === label)?.value;

  it('count towards revenue and visitors', () => {
    expect(kpi('Revenue (paid bookings)')).toBe(2200);
    expect(kpi('Visitors')).toBe(8);
    expect(kpi('Imported from booking book')).toBe(1000);
  });

  it('are not counted as cash collected through the system', () => {
    expect(kpi('Cash collected')).toBe(1200);
    const method = report.paymentMethods.find(row => row.Method === 'Booking book (imported)');
    expect(method?.['Cash collected (R)']).toBe(0);
    expect(method?.['Booking value (R)']).toBe(1000);
  });

  it('have their own channel, separate from online, office and gate sales', () => {
    const channel = (name: string) => report.channels.find(row => row.Channel === name);
    expect(channel('Online bookings')?.['Revenue (R)']).toBe(500);
    expect(channel('Office / phone bookings')?.['Revenue (R)']).toBe(400);
    expect(channel('Walk-in (gate) sales')?.['Revenue (R)']).toBe(300);
    expect(channel('Booking book (imported)')?.['Revenue (R)']).toBe(1000);
  });

  it('use readable payment method labels', () => {
    expect(report.paymentMethods.map(row => row.Method)).toEqual(expect.arrayContaining(['Office / phone: Cash', 'Booking book (imported)']));
    expect(report.bookings.find(row => row.Reference === 'IM-BOOK')?.['Payment method']).toBe('Booking book (imported)');
  });

  it('are left out of "how far ahead" and "time of day booked"', () => {
    // Online booked 2 days ahead, office 1 day, walk-in same day; the import (5 days "ahead") is left out.
    expect(kpi('Average days booked ahead')).toBe(1);
    expect(report.leadTime.reduce((sum, row) => sum + Number(row['Paid bookings']), 0)).toBe(3);
    expect(report.bookingHours.reduce((sum, row) => sum + Number(row['Bookings started']), 0)).toBe(3);
  });
});

describe('meal vouchers are issued even when the tickets already exist', () => {
  it('creates the missing meal vouchers on a retry', async () => {
    const inserts: Array<{ table: string; rows: Array<Record<string, unknown>> }> = [];
    // Tickets were saved by an earlier attempt that failed before the meal vouchers.
    const tables: Record<string, unknown> = {
      tickets: [{ ticket_uid: 'TKT-1', qr_token: 'x', visit_date: '2099-12-31' }],
      booking_items: [{ quantity: 1, package_id: null, hut_id: null, metadata: { name: 'Adult', isPerson: true }, bookings: { visit_date: '2099-12-31', customer_id: 'c1', voucher_credit_id: null } }],
      booking_spots: [],
      meal_vouchers: [],
      booking_specials: [{ special_id: 's1', quantity: 2, snapshot: { title: 'Family Package', free_meals: 0, included_meals: [{ name: 'Pizza', quantity: 1 }] } }],
      special_settings: { meal_name: 'Free Meal' },
    };
    const query = (table: string) => {
      const result = Promise.resolve({ data: tables[table], error: null });
      const chain = { eq: () => chain, in: () => chain, order: () => chain, maybeSingle: () => result, then: result.then.bind(result) };
      return chain;
    };
    vi.doMock('@/lib/supabase', () => ({
      supabase: {
        from: (table: string) => ({
          select: () => query(table),
          insert: (rows: Array<Record<string, unknown>>) => { inserts.push({ table, rows }); return Promise.resolve({ error: null }); },
        }),
      },
    }));
    vi.resetModules();
    const { generateTicketsAndSendEmail } = await import('@/lib/ticketing');
    await generateTicketsAndSendEmail('booking-1', '', 'Guest', { sendEmail: false });
    const meals = inserts.find(i => i.table === 'meal_vouchers')?.rows || [];
    expect(meals.length).toBe(2); // 1 pizza × 2 packages
    expect(meals.every(m => m.meal_name === 'Pizza' && m.visit_date === '2099-12-31')).toBe(true);
    expect(inserts.some(i => i.table === 'tickets')).toBe(false); // the existing tickets are reused
    vi.doUnmock('@/lib/supabase');
  });
});

describe('QR codes follow a booking to its new date', () => {
  it('re-signs unused tickets and meal vouchers so they scan on the new date', async () => {
    const updates: Array<{ table: string; values: Record<string, string> }> = [];
    vi.doMock('@/lib/supabase', () => ({
      supabase: {
        from: (table: string) => ({
          select: () => ({ eq: () => ({ eq: () => Promise.resolve({ data: table === 'tickets' ? [{ id: 't1', ticket_uid: 'TKT-1' }] : [{ id: 'm1', meal_uid: 'MEAL-1' }], error: null }) }) }),
          update: (values: Record<string, string>) => ({ eq: () => { updates.push({ table, values }); return Promise.resolve({ error: null }); } }),
        }),
      },
    }));
    vi.resetModules();
    const { resignBookingQrCodes } = await import('@/lib/ticketing');
    const { verifyQrToken } = await import('@/lib/qr-token');
    const result = await resignBookingQrCodes('booking-1', '2099-12-31');
    expect(result).toEqual({ tickets: 1, meals: 1 });
    const ticket = verifyQrToken(updates.find(u => u.table === 'tickets')!.values.qr_token);
    const meal = verifyQrToken(updates.find(u => u.table === 'meal_vouchers')!.values.qr_token);
    expect(ticket?.tid).toBe('TKT-1');
    expect(meal?.tid).toBe('MEAL-1');
    expect(meal?.type).toBe('meal');
    // Valid until the end of the new visit date.
    expect(ticket?.exp).toBe(Math.floor(new Date('2099-12-31T23:59:59.999Z').getTime() / 1000));
    expect(updates.every(u => u.values.visit_date === '2099-12-31')).toBe(true);
    vi.doUnmock('@/lib/supabase');
  });
});
