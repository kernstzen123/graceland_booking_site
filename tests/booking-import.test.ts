import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { buildImportTemplate, COLUMNS, readImportFile } from '@/lib/booking-import';

/** Fill the real template the way staff would, then read it back. */
async function fill(rows: Array<Record<string, string | number | Date>>) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await buildImportTemplate() as unknown as ArrayBuffer);
  const sheet = workbook.getWorksheet('Bookings')!;
  rows.forEach((values, index) => {
    const row = sheet.getRow(4 + index);
    COLUMNS.forEach((column, col) => { if (values[column.key] !== undefined) row.getCell(col + 1).value = values[column.key]; });
  });
  return readImportFile(await workbook.xlsx.writeBuffer() as unknown as ArrayBuffer);
}

describe('booking book import', () => {
  it('reads a birthday party with its hut, an extra table and meals', async () => {
    const [row] = await fill([{ date: new Date(Date.UTC(2026, 9, 17)), firstName: 'Thandi', lastName: 'Mokoena', phone: '082 123 4567', type: 'Birthday party', slot: '09:30–11:30', option: 'Option 2 (with hotdog)', partyChildren: 12, partyAdults: 6, partyPacks: 12, water: 'Yes', seating: 'H4, T2', notes: 'Own cake' }]);
    expect(row.error).toBeUndefined();
    expect(row.input.visitDate).toBe('2026-10-17');
    expect(row.input.party).toMatchObject({ enabled: true, option: 'option-2', children: 12, adults: 6, partyPacks: 12, slot: '09:30–11:30' });
    expect(row.input.party?.adultsWater).toEqual(Array(6).fill(true));
    // The first hut comes with the party; the table is an extra.
    expect(row.input.selections).toEqual({ 'hut-shaded': 1 });
    expect(row.input.spotNumbers).toEqual(['H4', 'T2']);
    expect(row.input.notes).toBe('Own cake');
  });

  it('reads day visitors, dry activities and a typed date', async () => {
    const [row] = await fill([{ date: '17/10/2026', firstName: 'Pieter', lastName: 'Botha', email: 'pieter@example.com', type: 'Day visitor', water: 'No', adults: 2, pensioners: 1, children: 3, toddlers: 1, infants: 1, seating: 'h5' }]);
    expect(row.error).toBeUndefined();
    expect(row.input.visitDate).toBe('2026-10-17');
    expect(row.input.selections).toEqual({ 'day-no-water-adult': 2, 'day-no-water-pensioner': 1, 'day-no-water-child': 3, 'day-no-water-toddler': 1, 'day-no-water-infant': 1, 'hut-covered': 1 });
    expect(row.input.party).toBeUndefined();
  });

  it('explains what is wrong with a row and skips empty rows', async () => {
    const rows = await fill([
      { date: '2026-10-17', firstName: 'No', lastName: 'Hut', phone: '0820000000', type: 'Birthday party', slot: '12:00–14:00', partyChildren: 10 },
      {},
      { date: '2026-10-17', firstName: 'Bad', lastName: 'Seat', phone: '0820000000', type: 'Day visitor', adults: 2, seating: 'Hut 4' },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0].error).toMatch(/needs a hut/);
    expect(rows[1].error).toMatch(/not a hut or table number/);
  });
});
