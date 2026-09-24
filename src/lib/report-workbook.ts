/**
 * Turns a Report (src/lib/reports.ts) into a formatted, multi-sheet Excel workbook.
 */
import ExcelJS from 'exceljs';
import type { Kpi, Report, Row } from '@/lib/reports';

const PRIMARY = 'FF0EA5E9';
const HEADER_TEXT = 'FFFFFFFF';
const STRIPE = 'FFF0F9FF';
const BORDER = 'FFE2E8F0';
const TITLE = 'FF0F172A';
const MUTED = 'FF64748B';

const CURRENCY_FORMAT = '"R" #,##0.00';
const PERCENT_FORMAT = '0.0"%"';

const isCurrency = (header: string) => header.includes('(R)');
const isPercent = (header: string) => header.includes('%');
/** Columns that are safe to total (counts and money, not averages or rates). */
const isSummable = (header: string, value: unknown) => typeof value === 'number' && !isPercent(header) && !/avg|average/i.test(header);

const thin = { style: 'thin' as const, color: { argb: BORDER } };
const border: Partial<ExcelJS.Borders> = { top: thin, bottom: thin, left: thin, right: thin };

function kpiFormat(kpi: Kpi) {
  if (kpi.format === 'currency') return CURRENCY_FORMAT;
  if (kpi.format === 'percent') return PERCENT_FORMAT;
  if (kpi.format === 'days') return '0.0 "days"';
  return Number.isInteger(kpi.value) ? '#,##0' : '#,##0.00';
}

/** Title block at the top of every sheet. Returns the next free row. */
function addTitle(sheet: ExcelJS.Worksheet, title: string, report: Report, note?: string) {
  sheet.getCell('A1').value = title;
  sheet.getCell('A1').font = { bold: true, size: 16, color: { argb: TITLE } };
  const basis = report.range.basis === 'visit' ? 'by visit date' : 'by booking date';
  sheet.getCell('A2').value = `Graceland Venues · ${report.range.from} to ${report.range.to} (${basis})`;
  sheet.getCell('A2').font = { color: { argb: MUTED } };
  let row = 3;
  if (note) {
    sheet.getCell(`A${row}`).value = note;
    sheet.getCell(`A${row}`).font = { italic: true, color: { argb: MUTED } };
    row += 1;
  }
  return row + 1;
}

/**
 * Write a table of rows starting at startRow. Headers come from the first row's
 * keys. Adds number formats, zebra striping, an optional totals row and an
 * optional section heading. Returns the next free row.
 */
function addTable(sheet: ExcelJS.Worksheet, startRow: number, rows: Row[], options: { heading?: string; totals?: boolean; emptyText?: string } = {}) {
  let rowIndex = startRow;
  if (options.heading) {
    sheet.getCell(rowIndex, 1).value = options.heading;
    sheet.getCell(rowIndex, 1).font = { bold: true, size: 12, color: { argb: TITLE } };
    rowIndex += 1;
  }
  if (!rows.length) {
    sheet.getCell(rowIndex, 1).value = options.emptyText || 'No data for this period.';
    sheet.getCell(rowIndex, 1).font = { italic: true, color: { argb: MUTED } };
    return rowIndex + 2;
  }

  const headers = Object.keys(rows[0]);
  const headerRow = sheet.getRow(rowIndex);
  headers.forEach((header, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = header;
    cell.font = { bold: true, color: { argb: HEADER_TEXT } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PRIMARY } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = border;
  });
  headerRow.height = 30;
  const firstDataRow = rowIndex + 1;

  rows.forEach((row, r) => {
    const excelRow = sheet.getRow(firstDataRow + r);
    headers.forEach((header, c) => {
      const cell = excelRow.getCell(c + 1);
      cell.value = row[header] ?? null;
      cell.border = border;
      if (typeof row[header] === 'number') {
        cell.numFmt = isCurrency(header) ? CURRENCY_FORMAT : isPercent(header) ? PERCENT_FORMAT : Number.isInteger(row[header]) ? '#,##0' : '#,##0.00';
      }
      if (r % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: STRIPE } };
    });
  });
  let lastRow = firstDataRow + rows.length - 1;

  if (options.totals && rows.length > 1) {
    const totalRow = sheet.getRow(lastRow + 1);
    totalRow.getCell(1).value = 'Total';
    headers.forEach((header, c) => {
      const cell = totalRow.getCell(c + 1);
      cell.font = { bold: true };
      cell.border = { ...border, top: { style: 'medium', color: { argb: TITLE } } };
      if (c === 0 || !isSummable(header, rows[0][header])) return;
      const column = sheet.getColumn(c + 1).letter;
      const result = rows.reduce((sum, row) => sum + Number(row[header] || 0), 0);
      cell.value = { formula: `SUM(${column}${firstDataRow}:${column}${lastRow})`, result };
      cell.numFmt = isCurrency(header) ? CURRENCY_FORMAT : '#,##0';
    });
    lastRow += 1;
  }

  // Widen columns to fit, within limits.
  headers.forEach((header, c) => {
    const column = sheet.getColumn(c + 1);
    const longest = Math.max(header.length * 0.9, ...rows.map(row => String(row[header] ?? '').length));
    column.width = Math.min(60, Math.max(column.width || 10, Math.ceil(longest) + 3));
  });
  return lastRow + 3;
}

function addSheet(workbook: ExcelJS.Workbook, name: string) {
  return workbook.addWorksheet(name, { properties: { defaultColWidth: 14 }, pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
}

export function buildReportWorkbook(report: Report) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Graceland Venues';
  workbook.created = new Date();

  // ── Summary ──
  const summary = addSheet(workbook, 'Summary');
  let row = addTitle(summary, 'Business report', report, `Compared with the previous period ${report.range.previousFrom} to ${report.range.previousTo}. Generated ${new Date(report.range.generatedAt).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' })}.`);
  const kpiHeader = summary.getRow(row);
  ['Measure', 'This period', 'Previous period', 'Change', 'Notes'].forEach((header, i) => {
    const cell = kpiHeader.getCell(i + 1);
    cell.value = header; cell.font = { bold: true, color: { argb: HEADER_TEXT } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PRIMARY } }; cell.border = border;
  });
  report.kpis.forEach((kpi, i) => {
    const excelRow = summary.getRow(row + 1 + i);
    const previous = kpi.previous ?? null;
    excelRow.getCell(1).value = kpi.label;
    excelRow.getCell(2).value = kpi.value;
    excelRow.getCell(3).value = kpi.previous === undefined ? '—' : previous;
    // Rates change by percentage points; everything else by relative percent.
    const points = kpi.format === 'percent';
    excelRow.getCell(4).value = previous && kpi.previous !== undefined ? Math.round((points ? kpi.value - previous : ((kpi.value - previous) / previous) * 100) * 10) / 10 : null;
    excelRow.getCell(5).value = kpi.hint || null;
    [2, 3].forEach(c => { excelRow.getCell(c).numFmt = kpiFormat(kpi); });
    excelRow.getCell(4).numFmt = points ? '+0.0" pts";-0.0" pts";0.0" pts"' : '+0.0"%";-0.0"%";0.0"%"';
    for (let c = 1; c <= 5; c++) {
      excelRow.getCell(c).border = border;
      if (i % 2 === 1) excelRow.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: STRIPE } };
    }
  });
  summary.getColumn(1).width = 34; summary.getColumn(2).width = 18; summary.getColumn(3).width = 18; summary.getColumn(4).width = 12; summary.getColumn(5).width = 60;
  row += report.kpis.length + 3;
  row = addTable(summary, row, report.funnel, { heading: 'Booking funnel' });
  row = addTable(summary, row, report.statusBreakdown, { heading: 'Bookings by outcome', totals: true });
  addTable(summary, row, report.vouchers, { heading: 'Vouchers' });

  // ── Time series ──
  const dateLabel = report.range.basis === 'visit' ? 'visit date' : 'booking date';
  const daily = addSheet(workbook, 'Daily');
  addTable(daily, addTitle(daily, `Daily performance by ${dateLabel}`, report), report.daily, { totals: true });
  daily.views = [{ state: 'frozen', ySplit: 5 }];
  const weekly = addSheet(workbook, 'Weekly');
  addTable(weekly, addTitle(weekly, `Weekly performance by ${dateLabel}`, report, 'Weeks start on Monday.'), report.weekly, { totals: true });
  const monthly = addSheet(workbook, 'Monthly');
  addTable(monthly, addTitle(monthly, `Monthly performance by ${dateLabel}`, report), report.monthly, { totals: true });
  const weekdays = addSheet(workbook, 'Weekdays');
  addTable(weekdays, addTitle(weekdays, 'Performance by day of the week', report, 'Averages are per open day, so busy and quiet weekdays can be compared fairly.'), report.weekdays);
  const peaks = addSheet(workbook, 'Peak days');
  addTable(peaks, addTitle(peaks, 'Busiest days', report), report.peakDays);

  // ── What sold ──
  const packages = addSheet(workbook, 'Packages');
  row = addTitle(packages, 'Sales by package and item', report, 'Paid bookings only.');
  row = addTable(packages, row, report.packages, { totals: true });
  addTable(packages, row, report.visitorMix, { heading: 'Visitor mix' });
  const payments = addSheet(workbook, 'Payments');
  row = addTitle(payments, 'Sales channels and payment methods', report, 'Paid bookings only. Booking value includes the part paid with vouchers.');
  row = addTable(payments, row, report.channels, { heading: 'Online vs walk-in', totals: true });
  addTable(payments, row, report.paymentMethods, { heading: 'Payment methods', totals: true });
  const parties = addSheet(workbook, 'Parties');
  row = addTitle(parties, 'Birthday parties', report);
  row = addTable(parties, row, report.parties.summary, { heading: 'Overview' });
  row = addTable(parties, row, report.parties.slots, { heading: 'By time slot', totals: true, emptyText: 'No paid parties in this period.' });
  addTable(parties, row, report.parties.options, { heading: 'By package', totals: true, emptyText: 'No paid parties in this period.' });

  // ── Behaviour and operations ──
  const behaviour = addSheet(workbook, 'Booking behaviour');
  row = addTitle(behaviour, 'How customers book', report, 'Times are South African time.');
  row = addTable(behaviour, row, report.leadTime, { heading: 'How far ahead customers book', totals: true });
  addTable(behaviour, row, report.bookingHours, { heading: 'Time of day bookings are made', totals: true });
  const checkIns = addSheet(workbook, 'Check-ins');
  addTable(checkIns, addTitle(checkIns, 'Gate check-ins and no-shows', report, 'Visit dates that have already passed. A no-show is a paid booking where no ticket was scanned.'), report.checkIns, { totals: true, emptyText: 'No visit dates in this period have passed yet.' });
  if (report.seating) {
    const seating = addSheet(workbook, 'Seating');
    addTable(seating, addTitle(seating, 'Hut and table utilisation', report, 'Spot-days booked divided by spots available on each open day.'), report.seating);
  }

  // ── Customers ──
  const customers = addSheet(workbook, 'Customers');
  row = addTitle(customers, 'Customers', report);
  row = addTable(customers, row, report.customers.summary, { heading: 'Overview' });
  addTable(customers, row, report.customers.top, { heading: 'Top 25 customers by spend' });

  // ── Raw data ──
  const bookings = addSheet(workbook, 'All bookings');
  const start = addTitle(bookings, 'All bookings in this period', report, 'Every booking started, including unpaid, expired and cancelled ones.');
  addTable(bookings, start, report.bookings, { totals: true });
  bookings.views = [{ state: 'frozen', ySplit: start }];
  if (report.bookings.length) {
    bookings.autoFilter = { from: { row: start, column: 1 }, to: { row: start, column: Object.keys(report.bookings[0]).length } };
  }

  return workbook;
}

