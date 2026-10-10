import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { buildDailySummary, type SummaryBooking } from '@/lib/daily-summary';
import { buildDailySummaryWorkbook } from '@/lib/daily-summary-workbook';

const SLOTS = ['09:30–11:30', '12:00–14:00', '14:30–16:30'];
const day = (itemId: string, quantity: number) => ({ quantity, metadata: { itemId, name: itemId, isPerson: true } });
const party = (name: string, quantity: number, isPerson = true) => ({ quantity, metadata: { party: true, name, isPerson } });

const partyBooking: SummaryBooking = {
  party_slot: '09:30–11:30',
  total_amount: 3580,
  customers: { first_name: 'Thandi', last_name: 'Mokoena' },
  booking_items: [
    party('Kiddy Party Option 2 (hotdog included)', 12, false),
    party('Birthday party child entrance', 12),
    party('Additional birthday party child entrance (swimming)', 2),
    party('Birthday party adult entrance (swimming)', 4),
    party('Birthday party adult entrance (non-swimming)', 2),
    party('Optional party pack', 10, false),
    { quantity: 1, metadata: { itemId: 'hut-covered', name: 'Covered Hut', isPerson: false } },
  ],
  booking_spots: [{ venue_spots: { number: 'H3', type: 'hut' } }],
};
const dayBooking: SummaryBooking = {
  party_slot: null,
  total_amount: 1240,
  customers: [{ first_name: 'Pieter', last_name: 'Botha' }],
  booking_items: [day('day-water-child', 2), day('day-no-water-toddler', 1), day('day-water-infant', 1), day('day-water-adult', 2), day('day-no-water-pensioner', 2), { quantity: 1, metadata: { itemId: 'hut-shaded', name: 'Shaded Table', isPerson: false } }],
  booking_spots: [{ venue_spots: { number: 'T10', type: 'table' } }, { venue_spots: { number: 'H2', type: 'hut' } }],
};

describe('daily summary', () => {
  it('counts a party booking once per guest and lists its meals', () => {
    const summary = buildDailySummary([partyBooking], SLOTS);
    expect(summary.parties.map(section => section.slot)).toEqual(SLOTS);
    expect(summary.parties[0].rows[0]).toMatchObject({ time: '09:30', client: 'Thandi Mokoena', total: 20, children: 14, adults: 6, toddlers: 0, meals: '12 hotdogs, 10 party packs', seating: 'H3', paid: 3580 });
    expect(summary.parties[1].rows).toEqual([]);
  });

  it('splits day visitors by age group and shows huts and tables', () => {
    const { dayVisitors } = buildDailySummary([dayBooking], SLOTS);
    expect(dayVisitors[0]).toMatchObject({ time: 'DV', client: 'Pieter Botha', total: 8, children: 2, toddlers: 1, infants: 1, adults: 2, pensioners: 2, meals: '', seating: 'H2, T10' });
  });

  it('writes on-site totals that add the day visitors to each slot', async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await buildDailySummaryWorkbook(buildDailySummary([partyBooking, dayBooking], SLOTS), '2026-10-03') as unknown as ArrayBuffer);
    const sheet = workbook.worksheets[0];
    const totals = new Map<string, { value: number; formula: string }>();
    sheet.eachRow(row => {
      const label = String(row.getCell(1).value ?? '');
      const cell = row.getCell(3).value as { result?: number; formula?: string } | number | null;
      if (cell && typeof cell === 'object') totals.set(label, { value: Number(cell.result), formula: String(cell.formula) });
    });
    expect(totals.get('Party guests 09:30–11:30')?.value).toBe(20);
    expect(totals.get('On site 09:30–11:30 (parties + day visitors)')?.value).toBe(28);
    expect(totals.get('On site 12:00–14:00 (parties + day visitors)')?.value).toBe(8);
    expect(totals.get('Total day visitors')?.value).toBe(8);
    expect(totals.get('Total booked for the day (day visitors + all parties)')?.value).toBe(28);
    // The on-site formula must point at the row the day visitor actually sits on.
    const dayVisitorRow = sheet.getColumn(1).values.findIndex(value => value === 'DV');
    expect(totals.get('On site 12:00–14:00 (parties + day visitors)')?.formula).toBe(`C${dayVisitorRow}`);
    // Day visitors come first, then the party slots.
    const labels = sheet.getColumn(1).values.map(value => String(value ?? ''));
    expect(labels.indexOf('Day visitors')).toBeLessThan(labels.indexOf('Birthday parties · 09:30–11:30'));
    expect(labels.indexOf('Total day visitors')).toBeLessThan(labels.indexOf('Birthday parties · 09:30–11:30'));
  });
});

describe('hut and table schedule in the daily summary', () => {
  const schedule = {
    date: '2026-10-03',
    slots: SLOTS,
    huts: [
      { number: 'H1', bookings: [{ slot: null, client: 'Pieter Botha', reference: 'BK-1', paid: true }] },
      { number: 'H2', bookings: [{ slot: '09:30–11:30', client: 'Thandi Mokoena', reference: 'BK-2', paid: true }, { slot: '14:30–16:30', client: 'Lerato Dube', reference: 'BK-3', paid: false }] },
      { number: 'H3', bookings: [] },
    ],
    tables: [
      { number: 'T1', bookings: [{ slot: '09:30–11:30', client: 'Thandi Mokoena', reference: 'BK-2', paid: true }] },
      { number: 'T2', bookings: [] },
    ],
  };

  it('lays out each hut by slot and each table for the day', async () => {
    const { hutScheduleRows } = await import('@/lib/daily-summary-workbook');
    const rows = hutScheduleRows(schedule);
    expect(rows.hutHeaders).toEqual(['Hut', 'All day (day visitors)', 'Party 09:30–11:30', 'Party 12:00–14:00', 'Party 14:30–16:30']);
    expect(rows.huts).toEqual([
      ['H1', 'Pieter Botha', '—', '—', '—'],
      ['H2', 'Free', 'Thandi Mokoena', 'Free', 'Lerato Dube (awaiting payment)'],
      ['H3', 'Free', 'Free', 'Free', 'Free'],
    ]);
    expect(rows.tables).toEqual([['T1', 'Thandi Mokoena (party 09:30–11:30)'], ['T2', 'Free']]);
  });

  it('adds the schedule as a second sheet', async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await buildDailySummaryWorkbook(buildDailySummary([partyBooking, dayBooking], SLOTS), '2026-10-03', schedule) as unknown as ArrayBuffer);
    expect(workbook.worksheets.map(sheet => sheet.name)).toEqual(['Daily summary', 'Huts & tables']);
    const values = workbook.worksheets[1].getSheetValues().flat().map(value => String(value ?? ''));
    expect(values).toContain('Covered huts');
    expect(values).toContain('Shaded tables');
    expect(values).toContain('Lerato Dube (awaiting payment)');
  });
});
