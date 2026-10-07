import { describe, expect, it, vi } from 'vitest';
import type { ReportData } from '@/lib/reports';

// reports.ts reads Supabase only in buildReport; assembleReport is pure.
vi.mock('@/lib/supabase', () => ({ supabase: {} }));

const booking = (reference: string, total: number, specials: Array<{ title: string; quantity: number }> | null) => ({
  id: reference, reference, visit_date: '2026-10-10', created_at: '2026-10-08T08:00:00Z', status: 'PAID', payment_method: 'PAYFAST',
  total_amount: total, amount_due: total, voucher_amount_used: 0, people_count: 4,
  party_slot: null, expires_at: null, voucher_issued: false,
  first_name: 'A', last_name: 'B', email: `${reference.toLowerCase()}@example.com`, phone: '0820000000',
  tickets_issued: 4, tickets_used: 0, items_summary: '4× Tickets', party_children: 0, party_option: null, party_packs: 0, specials,
});

const special = (title: string, type: string, sold: number, bookings: number, revenue: number, discount: number, free: number, issued: number, redeemed: number) => ({
  id: title, title, type, bundles_sold: sold, bookings, revenue, discount_value: discount, free_tickets: free, meals_issued: issued, meals_redeemed: redeemed, meals_cancelled: 0,
});

const data: ReportData = {
  bookings: [
    // One booking holds both specials: it must be counted once in "Bookings with a special".
    booking('BK-BOTH', 1980, [{ title: 'Family Package', quantity: 2 }, { title: 'Kids Free', quantity: 1 }]),
    booking('BK-FAMILY', 660, [{ title: 'Family Package', quantity: 1 }]),
    booking('BK-PLAIN', 860, null),
  ],
  items: [],
  previous: { started: 0, paid: 0, revenue: 0, collected: 0, visitors: 0 },
  returningEmails: [],
  seating: null,
  vouchers: { issuedCount: 0, issuedValue: 0, voidCount: 0, voidValue: 0, redeemedCount: 0, redeemedValue: 0, outstandingCount: 0, outstandingValue: 0 },
  capacity: 500,
  specials: [
    special('Kids Free', 'buy_x_get_y', 1, 1, 660, 220, 2, 0, 0),
    special('Family Package', 'tickets_and_meals', 3, 2, 1980, 600, 0, 3, 1),
  ],
};

describe('specials in reports', async () => {
  const { assembleReport } = await import('@/lib/reports');
  const report = assembleReport(data, '2026-10-10', '2026-10-10', 'visit', new Map(), '2026-10-07');
  const measure = (name: string) => report.specials.summary.find(row => row.Measure === name)?.Value;

  it('summarises specials sold, revenue, discounts, free tickets and meals', () => {
    expect(measure('Specials sold')).toBe(4);
    expect(measure('Bookings with a special')).toBe(2);
    expect(measure('Share of paid bookings %')).toBe(66.7);
    expect(measure('Special revenue (R)')).toBe(2640);
    expect(measure('Share of revenue %')).toBe(75.4); // 2640 of 3500
    expect(measure('Discount given (R)')).toBe(820);
    expect(measure('Free tickets given')).toBe(2);
    expect(measure('Meal vouchers issued')).toBe(3);
    expect(measure('Meal redemption %')).toBe(33.3);
  });

  it('lists each special, highest revenue first, with readable types', () => {
    expect(report.specials.bySpecial.map(row => row.Special)).toEqual(['Family Package', 'Kids Free']);
    expect(report.specials.bySpecial[0]).toMatchObject({ Type: 'Tickets + meals', Bookings: 2, Sold: 3, 'Revenue (R)': 1980, 'Average price (R)': 660, 'Meals redeemed': 1 });
    expect(report.specials.bySpecial[1]).toMatchObject({ Type: 'Buy X get Y free', 'Free tickets': 2 });
  });

  it('shows the specials on each booking in the bookings list', () => {
    expect(report.bookings.find(row => row.Reference === 'BK-BOTH')?.Specials).toBe('2× Family Package; 1× Kids Free');
    expect(report.bookings.find(row => row.Reference === 'BK-PLAIN')?.Specials).toBe('');
  });

  it('is empty when the database has no specials figures', () => {
    const empty = assembleReport({ ...data, specials: undefined }, '2026-10-10', '2026-10-10', 'visit', new Map(), '2026-10-07');
    expect(empty.specials.bySpecial).toEqual([]);
    expect(empty.specials.summary.find(row => row.Measure === 'Specials sold')?.Value).toBe(0);
  });

  it('adds a Specials sheet to the Excel export', async () => {
    const { buildReportWorkbook } = await import('@/lib/report-workbook');
    const sheet = buildReportWorkbook(report).getWorksheet('Specials');
    expect(sheet).toBeDefined();
    const cells = sheet!.getSheetValues().flat().filter(value => value !== undefined && value !== null);
    expect(cells).toEqual(expect.arrayContaining(['Overview', 'By special', 'Family Package', 'Kids Free', 'Specials sold', 2640]));
  });
});
