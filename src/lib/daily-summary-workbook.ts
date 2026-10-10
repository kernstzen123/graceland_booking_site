import 'server-only';
/**
 * Turns a DailySummary (src/lib/daily-summary.ts) into the printable Excel
 * sheet staff use on the day: the day visitors and their totals first, then
 * the party slots, each with the number of people on site during that slot
 * (its party guests plus all day visitors). A second sheet holds the hut and
 * table schedule for the day.
 */
import ExcelJS from 'exceljs';
import type { DailySummary, SummaryRow } from '@/lib/daily-summary';
import type { HutBooking, HutSchedule } from '@/lib/hut-schedule';

const NAVY = 'FF0C4A6E';
const BAND = 'FFE0F2FE';
const SUBTOTAL = 'FFF1F5F9';
const ON_SITE = 'FFFEF3C7';
const TOTAL = 'FFDCFCE7';
const BORDER = 'FFCBD5E1';
const MUTED = 'FF475569';
const CURRENCY_FORMAT = '"R" #,##0.00';

const HEADERS = ['Time', 'Client name', 'Total visitors', 'Children', 'Toddlers', 'Infants', 'Adults', 'Pensioners', 'Meals', 'Hut / table', 'Paid', 'Additional info'];
const WIDTHS = [10, 26, 10, 10, 10, 9, 9, 11, 26, 12, 13, 34];
const LAST_COLUMN = HEADERS.length;
const LEFT_ALIGNED = new Set([2, 9, 12]);
/** Total visitors … Pensioners. */
const COUNT_COLUMNS = [3, 4, 5, 6, 7, 8];
const PAID_COLUMN = 11;

const thin = { style: 'thin' as const, color: { argb: BORDER } };
const border: Partial<ExcelJS.Borders> = { top: thin, bottom: thin, left: thin, right: thin };
const fill = (argb: string): ExcelJS.Fill => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const letter = (column: number) => String.fromCharCode(64 + column);
type Range = [first: number, last: number];

const countsOf = (row: SummaryRow) => [row.total, row.children, row.toddlers, row.infants, row.adults, row.pensioners];
const sumOf = (rows: SummaryRow[]) => rows.reduce((sum, row) => sum.map((value, index) => value + countsOf(row)[index]), [0, 0, 0, 0, 0, 0]);
const paidOf = (rows: SummaryRow[]) => rows.reduce((sum, row) => sum + row.paid, 0);

const longDate = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-ZA', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

export async function buildDailySummaryWorkbook(summary: DailySummary, date: string, schedule?: HutSchedule) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Graceland Venues';
  workbook.created = new Date();
  const sheet = workbook.addWorksheet('Daily summary', {
    pageSetup: { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } },
  });
  sheet.columns = WIDTHS.map(width => ({ width }));

  sheet.mergeCells(1, 1, 1, LAST_COLUMN);
  sheet.getCell('A1').value = 'Graceland Venues: Daily Summary';
  sheet.getCell('A1').font = { bold: true, size: 16, color: { argb: NAVY } };
  sheet.getRow(1).height = 26;
  sheet.mergeCells(2, 1, 2, LAST_COLUMN);
  sheet.getCell('A2').value = `${longDate(date)}   ·   Paid online bookings (walk-in sales not included)${schedule ? '   ·   Hut and table schedule on the next sheet' : ''}`;
  sheet.getCell('A2').font = { size: 11, color: { argb: MUTED } };

  const header = sheet.getRow(4);
  header.values = HEADERS;
  header.height = 30;
  header.eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = fill(NAVY);
    cell.border = border;
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  });
  sheet.views = [{ state: 'frozen', ySplit: 4 }];
  sheet.pageSetup.printTitlesRow = '4:4';

  let next = 5;
  const styleRow = (row: ExcelJS.Row, background?: string, bold = false) => {
    for (let column = 1; column <= LAST_COLUMN; column++) {
      const cell = row.getCell(column);
      cell.border = border;
      if (background) cell.fill = fill(background);
      if (bold) cell.font = { bold: true };
      cell.alignment = { vertical: 'middle', horizontal: LEFT_ALIGNED.has(column) ? 'left' : 'center', wrapText: column === 9 || column === 12 };
    }
    row.getCell(PAID_COLUMN).numFmt = CURRENCY_FORMAT;
    row.height = 20;
  };
  const addBand = (text: string) => {
    sheet.mergeCells(next, 1, next, LAST_COLUMN);
    const cell = sheet.getCell(next, 1);
    cell.value = text;
    cell.font = { bold: true, color: { argb: NAVY } };
    cell.fill = fill(BAND);
    cell.border = border;
    sheet.getRow(next).height = 20;
    next += 1;
  };
  const addBooking = (booking: SummaryRow) => {
    const row = sheet.getRow(next);
    row.values = [booking.time, booking.client, { formula: `SUM(D${next}:H${next})`, result: booking.total }, booking.children, booking.toddlers, booking.infants, booking.adults, booking.pensioners, booking.meals, booking.seating, booking.paid, booking.owing > 0 ? `${booking.imported ? 'Booking book: owes' : 'Owes'} R ${booking.owing.toFixed(2)}` : booking.imported ? 'Booking book' : ''];
    styleRow(row);
    next += 1;
  };
  /** Add a block of bookings (or a "none" line). Returns the rows they occupy, if any. */
  const addBookings = (bookings: SummaryRow[], emptyText: string): Range | null => {
    if (!bookings.length) {
      sheet.mergeCells(next, 1, next, LAST_COLUMN);
      const cell = sheet.getCell(next, 1);
      cell.value = emptyText;
      cell.font = { italic: true, color: { argb: MUTED } };
      cell.border = border;
      next += 1;
      return null;
    }
    const firstRow = next;
    bookings.forEach(addBooking);
    return [firstRow, next - 1];
  };
  // Totals are formulas (with their values filled in) so they follow any number staff change.
  const formulaFor = (column: number, ranges: Range[]) => ranges.map(([a, b]) => (a === b ? `${letter(column)}${a}` : `SUM(${letter(column)}${a}:${letter(column)}${b})`)).join('+');
  const addTotals = (label: string, ranges: Range[], counts: number[], paid: number | null, background: string) => {
    const row = sheet.getRow(next);
    sheet.mergeCells(next, 1, next, 2);
    row.getCell(1).value = label;
    COUNT_COLUMNS.forEach((column, index) => { row.getCell(column).value = ranges.length ? { formula: formulaFor(column, ranges), result: counts[index] } : 0; });
    if (paid !== null) row.getCell(PAID_COLUMN).value = ranges.length ? { formula: formulaFor(PAID_COLUMN, ranges), result: paid } : 0;
    styleRow(row, background, true);
    row.getCell(1).alignment = { vertical: 'middle', horizontal: 'left' };
    next += 1;
  };

  // Day visitors first: they are on site all day, so every party slot's "on site" line below counts them too.
  const dayVisitors = summary.dayVisitors;
  const dayVisitorCounts = sumOf(dayVisitors);
  addBand('Day visitors');
  const dayVisitorRange = addBookings(dayVisitors, 'No day visitors booked.');
  addTotals('Total day visitors', dayVisitorRange ? [dayVisitorRange] : [], dayVisitorCounts, paidOf(dayVisitors), TOTAL);
  next += 1;

  const partyRanges: Range[] = [];
  const allParties: SummaryRow[] = [];
  for (const section of summary.parties) {
    addBand(`Birthday parties · ${section.slot}`);
    const range = addBookings(section.rows, 'No parties booked for this time slot.');
    if (range) partyRanges.push(range);
    allParties.push(...section.rows);
    const partyCounts = sumOf(section.rows);
    addTotals(`Party guests ${section.slot}`, range ? [range] : [], partyCounts, paidOf(section.rows), SUBTOTAL);
    const onSiteRanges = [range, dayVisitorRange].filter((value): value is Range => Boolean(value));
    addTotals(`On site ${section.slot} (parties + day visitors)`, onSiteRanges, partyCounts.map((value, index) => value + dayVisitorCounts[index]), null, ON_SITE);
    next += 1;
  }

  const everyone = [...dayVisitors, ...allParties];
  addTotals('Total booked for the day (day visitors + all parties)', [...(dayVisitorRange ? [dayVisitorRange] : []), ...partyRanges], sumOf(everyone), paidOf(everyone), SUBTOTAL);

  if (schedule) addHutScheduleSheet(workbook, schedule);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** One booking in a schedule cell: the client, the party slot for a table, and whether it is still unpaid. */
const scheduleName = (booking: HutBooking, showSlot: boolean) => `${booking.client}${showSlot && booking.slot ? ` (party ${booking.slot})` : ''}${booking.paid ? '' : ' (awaiting payment)'}`;

/**
 * The hut and table schedule as the dashboard shows it: a row per hut with the
 * day visitors who have it all day or the party in each time slot, then a row
 * per table with who has it for the day.
 */
export function hutScheduleRows(schedule: HutSchedule) {
  const free = 'Free';
  const huts = schedule.huts.map(hut => {
    const allDay = hut.bookings.filter(booking => !booking.slot);
    const names = (bookings: HutBooking[]) => (bookings.length ? bookings.map(booking => scheduleName(booking, false)).join('\n') : free);
    return [hut.number, names(allDay), ...schedule.slots.map(slot => (allDay.length ? '—' : names(hut.bookings.filter(booking => booking.slot === slot))))];
  });
  const tables = schedule.tables.map(table => [table.number, table.bookings.length ? table.bookings.map(booking => scheduleName(booking, true)).join('\n') : free]);
  return { hutHeaders: ['Hut', 'All day (day visitors)', ...schedule.slots.map(slot => `Party ${slot}`)], huts, tableHeaders: ['Table', 'Booked by (all day)'], tables };
}

function addHutScheduleSheet(workbook: ExcelJS.Workbook, schedule: HutSchedule) {
  const { hutHeaders, huts, tableHeaders, tables } = hutScheduleRows(schedule);
  const columns = Math.max(hutHeaders.length, tableHeaders.length);
  const sheet = workbook.addWorksheet('Huts & tables', {
    pageSetup: { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } },
  });
  sheet.columns = Array.from({ length: columns }, (_, index) => ({ width: index === 0 ? 10 : 28 }));

  sheet.mergeCells(1, 1, 1, columns);
  sheet.getCell('A1').value = 'Graceland Venues: Hut & Table Schedule';
  sheet.getCell('A1').font = { bold: true, size: 16, color: { argb: NAVY } };
  sheet.getRow(1).height = 26;
  sheet.mergeCells(2, 1, 2, columns);
  const bookedHuts = schedule.huts.filter(hut => hut.bookings.length).length;
  const bookedTables = schedule.tables.filter(table => table.bookings.length).length;
  sheet.getCell('A2').value = `${longDate(schedule.date)}   ·   ${bookedHuts} of ${schedule.huts.length} huts and ${bookedTables} of ${schedule.tables.length} tables booked`;
  sheet.getCell('A2').font = { size: 11, color: { argb: MUTED } };
  sheet.mergeCells(3, 1, 3, columns);
  sheet.getCell('A3').value = 'A party has its hut from 15 minutes before its slot until 15 minutes after, so the hut must be cleared for the next party. Tables are booked for the whole day.';
  sheet.getCell('A3').font = { italic: true, size: 10, color: { argb: MUTED } };
  sheet.getCell('A3').alignment = { wrapText: true, vertical: 'top' };
  sheet.getRow(3).height = 28;

  let next = 5;
  const addTable = (title: string, headers: string[], rows: string[][]) => {
    sheet.mergeCells(next, 1, next, headers.length);
    const band = sheet.getCell(next, 1);
    band.value = title;
    band.font = { bold: true, color: { argb: NAVY } };
    band.fill = fill(BAND);
    band.border = border;
    sheet.getRow(next).height = 20;
    next += 1;
    const header = sheet.getRow(next);
    header.values = headers;
    header.height = 22;
    header.eachCell(cell => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = fill(NAVY);
      cell.border = border;
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    });
    next += 1;
    for (const values of rows) {
      const row = sheet.getRow(next);
      row.values = values;
      const lines = Math.max(1, ...values.map(value => value.split('\n').length));
      row.height = Math.max(20, lines * 15);
      values.forEach((value, index) => {
        const cell = row.getCell(index + 1);
        cell.border = border;
        cell.alignment = { vertical: 'middle', horizontal: index === 0 ? 'center' : 'left', wrapText: true };
        if (index === 0) cell.font = { bold: true };
        else if (value === 'Free' || value === '—') cell.font = { color: { argb: MUTED } };
      });
      next += 1;
    }
    next += 1;
  };
  addTable('Covered huts', hutHeaders, huts);
  if (tables.length) addTable('Shaded tables', tableHeaders, tables);
}
