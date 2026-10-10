import { describe, expect, it, vi } from 'vitest';
import { ImportedPaymentError, importedPaymentReference, isImportedPaymentRow, paidFromNotes, parseImportedPayment, paymentSummary, voucherRefundAmount } from '@/lib/imported-payments';
import { buildDailySummary } from '@/lib/daily-summary';
import type { ReportData } from '@/lib/reports';

// reports.ts reads Supabase only in buildReport; assembleReport is pure.
vi.mock('@/lib/supabase', () => ({ supabase: {} }));

describe('recording a payment on an imported booking', () => {
  const today = '2026-10-08';
  it('accepts an amount, method, date and note', () => {
    expect(parseImportedPayment({ amount: 1080, method: 'cash', paidOn: '2026-09-30', note: '  Deposit\t1 ' }, today)).toEqual({ amount: 1080, method: 'CASH', paidOn: '2026-09-30', note: 'Deposit 1' });
    expect(parseImportedPayment({ amount: '550.50', method: 'EFT', paidOn: today }, today)).toMatchObject({ amount: 550.5, note: '' });
  });
  it('refuses amounts, methods and dates that cannot be right', () => {
    const bad = (input: Record<string, unknown>) => () => parseImportedPayment({ amount: 100, method: 'CASH', paidOn: today, ...input }, today);
    expect(bad({ amount: 0 })).toThrow(ImportedPaymentError);
    expect(bad({ amount: -50 })).toThrow(/amount/);
    expect(bad({ amount: 'abc' })).toThrow(/amount/);
    expect(bad({ amount: 10.555 })).toThrow(/2 decimals/);
    expect(bad({ amount: 250000 })).toThrow(/cannot be more/);
    expect(bad({ method: 'BITCOIN' })).toThrow(/cash, card or EFT/);
    expect(bad({ paidOn: '2026-10-09' })).toThrow(/future/);
    expect(bad({ paidOn: '2026-02-30' })).toThrow(/date/);
    expect(bad({ paidOn: '' })).toThrow(/date/);
  });
  it('marks recorded payments so they can be told apart from PayFast and office payments', () => {
    expect(importedPaymentReference('')).toBe('IMPORTED');
    expect(importedPaymentReference('receipt 12')).toBe('IMPORTED · receipt 12');
    expect(isImportedPaymentRow({ provider_reference: 'IMPORTED · receipt 12' })).toBe(true);
    expect(isImportedPaymentRow({ provider_reference: 'pf_123' })).toBe(false);
    expect(isImportedPaymentRow({ provider_reference: null })).toBe(false);
  });
});

describe('balance of a booking', () => {
  it('works out paid and outstanding from completed payments only', () => {
    expect(paymentSummary(1960, [])).toEqual({ total: 1960, paid: 0, outstanding: 1960, overpaid: 0, state: 'UNPAID' });
    expect(paymentSummary(1960, [{ amount: 1080, status: 'COMPLETE' }, { amount: 500, status: 'VOID' }])).toEqual({ total: 1960, paid: 1080, outstanding: 880, overpaid: 0, state: 'PARTIAL' });
    expect(paymentSummary(1960, [{ amount: '1080', status: 'COMPLETE' }, { amount: 880, status: 'COMPLETE' }]).state).toBe('PAID');
    expect(paymentSummary(630, [{ amount: 970, status: 'COMPLETE' }])).toMatchObject({ outstanding: 0, overpaid: 340, state: 'OVERPAID' });
    expect(paymentSummary(0, []).state).toBe('PAID'); // fully paid with a voucher
    expect(paymentSummary(100, [{ amount: 33.33, status: 'COMPLETE' }, { amount: 33.33, status: 'COMPLETE' }, { amount: 33.34, status: 'COMPLETE' }]).state).toBe('PAID');
  });
});

describe('reading the amounts paid from the booking-book notes', () => {
  // The wording used on the live imported bookings.
  it.each([
    ['IMPORTED_FROM_BOOK\nno payment', 0],
    ['IMPORTED_FROM_BOOK\nno payment hut 6 and 7 Vuyolwethu Arosi', 0],
    ['IMPORTED_FROM_BOOK\nno payment + 11 life jackets hut 12 and hut 13', 0],
    ['IMPORTED_FROM_BOOK\npaid R1080', 1080],
    ['IMPORTED_FROM_BOOK\nPaid R550 - kids name is Tyler', 550],
    ['IMPORTED_FROM_BOOK\nPaid R4550', 4550],
    ['paid R 1 595', 1595],
    ['paid R2,240.50', 2240.5],
    ['IMPORTED_FROM_BOOK', null],
    ['', null],
    ['call to confirm', null],
    ['no payment, paid R100 later', null],
  ])('%j → %s', (notes, expected) => {
    expect(paidFromNotes(notes)).toBe(expected);
  });
});

describe('payments on imported bookings in reports and the daily sheet', async () => {
  const { assembleReport } = await import('@/lib/reports');
  const row = (reference: string, payment_method: string, total: number, amount_paid?: number) => ({
    id: reference, reference, visit_date: '2026-10-10', created_at: '2026-10-05T08:00:00Z', status: 'PAID', payment_method,
    total_amount: total, amount_due: total, voucher_amount_used: 0, people_count: 2, party_slot: null, expires_at: null, voucher_issued: false,
    first_name: 'A', last_name: 'B', email: `${reference.toLowerCase()}@example.com`, phone: '0820000000',
    tickets_issued: 0, tickets_used: 0, items_summary: '2× Adult', party_children: 0, party_option: null, party_packs: 0, amount_paid,
  });
  const data: ReportData = {
    bookings: [row('BK-ONLINE', 'PAYFAST', 500, 500), row('IM-PART', 'IMPORTED', 1960, 1080), row('IM-NONE', 'IMPORTED', 1000, 0), row('IM-FULL', 'IMPORTED', 800, 800)],
    items: [], previous: { started: 0, paid: 0, revenue: 0, collected: 0, visitors: 0 }, returningEmails: [], seating: null,
    vouchers: { issuedCount: 0, issuedValue: 0, voidCount: 0, voidValue: 0, redeemedCount: 0, redeemedValue: 0, outstandingCount: 0, outstandingValue: 0 }, capacity: 500,
  };
  const report = assembleReport(data, '2026-10-10', '2026-10-10', 'visit', new Map(), '2026-10-07');
  const kpi = (label: string) => report.kpis.find(k => k.label === label)?.value;

  it('count what was paid as cash collected, and show what is still owed', () => {
    expect(kpi('Cash collected')).toBe(500 + 1080 + 800);
    expect(kpi('Still owed (booking book)')).toBe(880 + 1000);
    expect(report.kpis.find(k => k.label === 'Still owed (booking book)')?.hint).toMatch(/^2 imported bookings/);
    expect(report.paymentMethods.find(r => r.Method === 'Booking book (imported)')?.['Cash collected (R)']).toBe(1880);
    expect(report.bookings.find(r => r.Reference === 'IM-PART')).toMatchObject({ 'Cash collected (R)': 1080, 'Outstanding (R)': 880 });
    expect(report.bookings.find(r => r.Reference === 'BK-ONLINE')?.['Outstanding (R)']).toBe(0);
  });

  it('show what was paid and what is owed on the daily sheet', () => {
    const summary = buildDailySummary([
      { party_slot: null, total_amount: 1960, payment_method: 'IMPORTED', customers: { first_name: 'Part' }, payments: [{ amount: 1080, status: 'COMPLETE' }, { amount: 100, status: 'VOID' }], booking_items: [{ quantity: 2, metadata: { itemId: 'day-water-adult', isPerson: true } }] },
      { party_slot: null, total_amount: 500, payment_method: 'PAYFAST', customers: { first_name: 'Online' }, payments: [], booking_items: [{ quantity: 2, metadata: { itemId: 'day-water-adult', isPerson: true } }] },
    ], []);
    const byName = (name: string) => summary.dayVisitors.find(r => r.client === name)!;
    expect(byName('Part')).toMatchObject({ paid: 1080, owing: 880, imported: true });
    expect(byName('Online')).toMatchObject({ paid: 500, owing: 0, imported: false });
  });

  it('count a payment recorded on an online booking after its total went up', () => {
    const edited = { ...row('BK-EDITED', 'PAYFAST', 700, 600), amount_due: 500 };
    const unpaid = { ...row('BK-OWES', 'PAYFAST', 700, 500), amount_due: 500 };
    const editedReport = assembleReport({ ...data, bookings: [edited, unpaid] }, '2026-10-10', '2026-10-10', 'visit', new Map(), '2026-10-07');
    expect(editedReport.bookings.find(r => r.Reference === 'BK-EDITED')).toMatchObject({ 'Cash collected (R)': 600, 'Outstanding (R)': 100 });
    expect(editedReport.bookings.find(r => r.Reference === 'BK-OWES')).toMatchObject({ 'Cash collected (R)': 500, 'Outstanding (R)': 200 });
  });

  it('show what an edited online booking still owes on the daily sheet', () => {
    const summary = buildDailySummary([
      { party_slot: null, total_amount: 700, amount_due: 500, payment_method: 'PAYFAST', customers: { first_name: 'Edited' }, payments: [{ amount: 500, status: 'COMPLETE' }], booking_items: [{ quantity: 2, metadata: { itemId: 'day-water-adult', isPerson: true } }] },
      { party_slot: null, total_amount: 700, amount_due: 500, payment_method: 'PAYFAST', customers: { first_name: 'Settled' }, payments: [{ amount: 500, status: 'COMPLETE' }, { amount: 200, status: 'COMPLETE' }], booking_items: [{ quantity: 2, metadata: { itemId: 'day-water-adult', isPerson: true } }] },
      { party_slot: null, total_amount: 500, amount_due: 300, voucher_amount_used: 200, payment_method: 'PAYFAST', customers: { first_name: 'Voucher' }, payments: [{ amount: 300, status: 'COMPLETE' }], booking_items: [{ quantity: 2, metadata: { itemId: 'day-water-adult', isPerson: true } }] },
    ], []);
    const byName = (name: string) => summary.dayVisitors.find(r => r.client === name)!;
    expect(byName('Edited')).toMatchObject({ paid: 500, owing: 200 });
    expect(byName('Settled')).toMatchObject({ paid: 700, owing: 0 });
    expect(byName('Voucher')).toMatchObject({ paid: 500, owing: 0 });
  });
});

describe('voucher refund amount (as issue_booking_voucher works it out)', () => {
  it('refunds what was paid', () => {
    expect(voucherRefundAmount({ total_amount: 700, payment_method: 'PAYFAST', payments: [{ amount: 500, status: 'COMPLETE' }, { amount: 200, status: 'COMPLETE' }, { amount: 90, status: 'VOID' }] })).toBe(700);
    expect(voucherRefundAmount({ total_amount: 1960, payment_method: 'IMPORTED', payments: [{ amount: 1080, status: 'COMPLETE' }] })).toBe(1080);
  });
  it('falls back to the total only for bookings paid online without a payment line', () => {
    expect(voucherRefundAmount({ total_amount: 450, payment_method: 'PAYFAST', payments: [] })).toBe(450);
    expect(voucherRefundAmount({ total_amount: 1000, payment_method: 'IMPORTED', payments: [] })).toBe(0);
  });
});
