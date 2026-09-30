import 'server-only';
/**
 * The spreadsheet staff fill in from the paper booking book, and reading it
 * back. The template and the reader share COLUMNS, so they always match.
 */
import ExcelJS from 'exceljs';
import type { PartyDetails } from '@/lib/parties';
import { PARTY_SLOTS } from '@/lib/parties';

const PARTY_SLOT_OPTIONS = [...new Set([...PARTY_SLOTS.saturday, ...PARTY_SLOTS.sunday, ...PARTY_SLOTS.weekday])];
const BOOKING_TYPES = ['Day visitor', 'Birthday party'];
const PARTY_OPTIONS = ['Option 1', 'Option 2 (with hotdog)'];
const YES_NO = ['Yes', 'No'];

type Column = { key: string; header: string; width: number; help: string; list?: string[]; number?: boolean; date?: boolean; required?: boolean };
export const COLUMNS: Column[] = [
  { key: 'date', header: 'Visit date', width: 13, date: true, required: true, help: 'The day they are coming, e.g. 2026-10-17.' },
  { key: 'firstName', header: 'First name', width: 16, required: true, help: 'Customer first name.' },
  { key: 'lastName', header: 'Surname', width: 18, required: true, help: 'Customer surname.' },
  { key: 'phone', header: 'Phone', width: 15, help: 'Phone number (a phone or an email is required).' },
  { key: 'email', header: 'Email', width: 26, help: 'Email address, if written down. No tickets are emailed.' },
  { key: 'type', header: 'Booking type', width: 15, list: BOOKING_TYPES, required: true, help: 'Day visitor or Birthday party.' },
  { key: 'slot', header: 'Party time slot', width: 15, list: PARTY_SLOT_OPTIONS, help: 'Parties only. Saturdays 09:30, 12:00, 14:30; Sundays and public holidays 10:30, 13:00; weekdays 14:30.' },
  { key: 'option', header: 'Party option', width: 22, list: PARTY_OPTIONS, help: 'Parties only. Option 2 includes a hotdog per child.' },
  { key: 'partyChildren', header: 'Party children', width: 10, number: true, help: 'Parties only. The birthday party children.' },
  { key: 'partyAdults', header: 'Party adults', width: 10, number: true, help: 'Parties only. Adults with the party.' },
  { key: 'partyPacks', header: 'Party packs', width: 10, number: true, help: 'Parties only. Number of party packs.' },
  { key: 'water', header: 'Water activities', width: 11, list: YES_NO, help: 'Yes if they swim / use the water activities, No for dry activities only. Blank = Yes.' },
  { key: 'adults', header: 'Adults', width: 9, number: true, help: 'Day-visitor adults (for a party: any extra adults not in the party).' },
  { key: 'pensioners', header: 'Pensioners', width: 10, number: true, help: 'Day-visitor pensioners.' },
  { key: 'children', header: 'Children 3-17', width: 10, number: true, help: 'Day-visitor children aged 3 to 17.' },
  { key: 'toddlers', header: 'Toddlers 1-2', width: 10, number: true, help: 'Toddlers aged 1 and 2.' },
  { key: 'infants', header: 'Infants under 1', width: 10, number: true, help: 'Babies under 1 (free).' },
  { key: 'seating', header: 'Huts / tables', width: 13, help: 'Hut and table numbers, e.g. H4 or H4, T2. A party must have a hut.' },
  { key: 'notes', header: 'Notes', width: 30, help: 'Anything else from the book. Kept on the booking for staff.' },
];

const HEADER_ROW = 3;
const FIRST_DATA_ROW = 4;
const LAST_DATA_ROW = 503;
const NAVY = 'FF0C4A6E';

/** The empty spreadsheet staff type the booking book into. */
export async function buildImportTemplate() {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Graceland Venues';
  const sheet = workbook.addWorksheet('Bookings', { views: [{ state: 'frozen', ySplit: HEADER_ROW, xSplit: 3 }] });
  sheet.columns = COLUMNS.map(column => ({ width: column.width }));
  sheet.getCell('A1').value = 'Graceland Venues: bookings from the booking book';
  sheet.getCell('A1').font = { bold: true, size: 14, color: { argb: NAVY } };
  sheet.getCell('A2').value = 'One row per booking. Grey headings are required. Read the Instructions sheet first. Do not change the headings.';
  sheet.getCell('A2').font = { italic: true, color: { argb: 'FF475569' } };

  const header = sheet.getRow(HEADER_ROW);
  header.values = COLUMNS.map(column => column.header);
  header.height = 32;
  COLUMNS.forEach((column, index) => {
    const cell = header.getCell(index + 1);
    cell.font = { bold: true, color: { argb: column.required ? 'FF0F172A' : 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: column.required ? 'FFCBD5E1' : NAVY } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.note = column.help;
    for (let row = FIRST_DATA_ROW; row <= LAST_DATA_ROW; row++) {
      const target = sheet.getCell(row, index + 1);
      if (column.list) target.dataValidation = { type: 'list', allowBlank: true, formulae: [`"${column.list.join(',')}"`], showErrorMessage: true, errorTitle: column.header, error: `Choose from the list: ${column.list.join(', ')}` };
      else if (column.number) target.dataValidation = { type: 'whole', operator: 'between', allowBlank: true, formulae: [0, 500], showErrorMessage: true, error: 'Enter a whole number (or leave empty for 0).' };
      else if (column.date) { target.dataValidation = { type: 'date', operator: 'greaterThan', allowBlank: true, formulae: [new Date(Date.UTC(2026, 0, 1))], showErrorMessage: true, error: 'Enter a date, e.g. 2026-10-17.' }; target.numFmt = 'yyyy-mm-dd'; }
    }
  });

  const help = workbook.addWorksheet('Instructions');
  help.columns = [{ width: 22 }, { width: 100 }];
  help.addRow(['How to fill in the Bookings sheet']).font = { bold: true, size: 14, color: { argb: NAVY } };
  help.addRow([]);
  for (const line of [
    ['1', 'Type one booking per row on the Bookings sheet, starting on row 4. Use the drop-down lists where there is one.'],
    ['2', 'Imported bookings are NOT emailed QR tickets. Staff check them in at the gate by name, phone or email.'],
    ['3', 'Payments and deposits are not recorded. Keep those in the book as before.'],
    ['4', 'For a birthday party, fill in the party columns and the hut. Any extra day visitors with the party go in the Adults / Children columns.'],
    ['5', 'In the staff portal go to Add booking > Import, upload this file and click Check file. Fix any rows it reports, then click Import.'],
    ['6', 'Importing the same file again is safe: rows already imported are skipped.'],
  ]) help.addRow(line);
  help.addRow([]);
  help.addRow(['Column', 'What to enter']).font = { bold: true };
  for (const column of COLUMNS) help.addRow([`${column.header}${column.required ? ' (required)' : ''}`, column.help]);
  help.addRow([]);
  help.addRow(['Example', '2026-10-17 · Thandi · Mokoena · 0821234567 · · Birthday party · 09:30–11:30 · Option 2 (with hotdog) · 12 · 6 · 12 · Yes · · · · · · H4 · Bringing own cake']).font = { italic: true, color: { argb: 'FF475569' } };
  help.eachRow(row => row.eachCell(cell => { cell.alignment = { wrapText: true, vertical: 'top' }; }));

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export type ImportRow = {
  row: number;
  input: { visitDate: string; customer: { firstName: string; lastName: string; email: string; phone: string }; selections: Record<string, number>; party?: PartyDetails; spotNumbers: string[]; notes: string };
  error?: string;
};

const text = (value: ExcelJS.CellValue): string => {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if ('text' in value && typeof value.text === 'string') return value.text.trim();
    if ('result' in value) return text(value.result as ExcelJS.CellValue);
    if ('richText' in value) return value.richText.map(part => part.text).join('').trim();
    if ('hyperlink' in value) return String(value.hyperlink).replace(/^mailto:/i, '').trim();
  }
  return String(value).trim();
};

function toDate(value: ExcelJS.CellValue) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const raw = text(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const dmy = raw.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  return raw;
}

function toCount(value: ExcelJS.CellValue, header: string) {
  const raw = text(value);
  if (!raw) return 0;
  const count = Number(raw);
  if (!Number.isInteger(count) || count < 0 || count > 500) throw new Error(`${header} must be a whole number.`);
  return count;
}

/** Read the Bookings sheet. Empty rows are skipped; a row that cannot be read carries an error. */
export async function readImportFile(buffer: ArrayBuffer): Promise<ImportRow[]> {
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(buffer); } catch { throw new Error('This is not an Excel (.xlsx) file. Use the template from the Import page.'); }
  const sheet = workbook.getWorksheet('Bookings') || workbook.worksheets[0];
  if (!sheet) throw new Error('The file has no Bookings sheet.');

  // Find the columns by heading, so a moved column still reads correctly.
  let headerRow = 0;
  const columnOf = new Map<string, number>();
  for (let row = 1; row <= 10 && !headerRow; row++) {
    const headings = new Map<string, number>();
    sheet.getRow(row).eachCell((cell, col) => headings.set(text(cell.value).toLowerCase(), col));
    if (headings.has('visit date') && headings.has('surname')) {
      headerRow = row;
      for (const column of COLUMNS) { const col = headings.get(column.header.toLowerCase()); if (col) columnOf.set(column.key, col); }
    }
  }
  if (!headerRow) throw new Error('Could not find the headings (Visit date, Surname, …). Use the template from the Import page.');
  const missing = COLUMNS.filter(column => column.required && !columnOf.has(column.key)).map(column => column.header);
  if (missing.length) throw new Error(`The file is missing these columns: ${missing.join(', ')}.`);

  const rows: ImportRow[] = [];
  for (let rowNumber = headerRow + 1; rowNumber <= sheet.rowCount; rowNumber++) {
    const row = sheet.getRow(rowNumber);
    const cell = (key: string) => (columnOf.has(key) ? row.getCell(columnOf.get(key)!).value : null);
    const values = COLUMNS.map(column => text(cell(column.key)));
    if (values.every(value => !value)) continue;

    const input: ImportRow['input'] = {
      visitDate: toDate(cell('date')),
      customer: { firstName: text(cell('firstName')), lastName: text(cell('lastName')), email: text(cell('email')), phone: text(cell('phone')) },
      selections: {},
      spotNumbers: text(cell('seating')).toUpperCase().split(/[\s,;/&]+|\bAND\b/).map(value => value.trim()).filter(Boolean),
      notes: text(cell('notes')).slice(0, 500),
    };
    try {
      const count = (key: string) => toCount(cell(key), COLUMNS.find(column => column.key === key)!.header);
      const water = !/^n/i.test(text(cell('water')));
      const prefix = water ? 'day-water' : 'day-no-water';
      const add = (id: string, quantity: number) => { if (quantity > 0) input.selections[id] = (input.selections[id] || 0) + quantity; };
      add(`${prefix}-adult`, count('adults'));
      add(`${prefix}-pensioner`, count('pensioners'));
      add(`${prefix}-child`, count('children'));
      add(`${prefix}-toddler`, count('toddlers'));
      add(`${prefix}-infant`, count('infants'));

      const bad = input.spotNumbers.find(number => !/^[HT]\d{1,2}$/.test(number));
      if (bad) throw new Error(`"${bad}" is not a hut or table number. Use H1–H16 or T1–T12.`);
      const hutCount = input.spotNumbers.filter(number => number.startsWith('H')).length;
      const tableCount = input.spotNumbers.filter(number => number.startsWith('T')).length;

      const type = text(cell('type')).toLowerCase();
      if (!type) throw new Error('Choose the booking type (Day visitor or Birthday party).');
      if (type.startsWith('birth') || type.startsWith('party')) {
        const slot = text(cell('slot')).replace(/-/g, '–').replace(/\s+/g, '');
        if (!slot) throw new Error('Choose the party time slot.');
        if (hutCount < 1) throw new Error('A birthday party needs a hut: enter its number in Huts / tables (e.g. H4).');
        const adults = count('partyAdults');
        input.party = {
          enabled: true,
          option: /2|hotdog/i.test(text(cell('option'))) ? 'option-2' : 'option-1',
          children: count('partyChildren'),
          adults,
          adultsWater: Array.from({ length: adults }, () => water),
          additionalChildren: 0,
          additionalChildrenWater: [],
          partyPacks: count('partyPacks'),
          slot,
        };
        if (!input.party.children) throw new Error('Enter the number of party children.');
        add('hut-covered', hutCount - 1);
      } else {
        add('hut-covered', hutCount);
      }
      add('hut-shaded', tableCount);
      rows.push({ row: rowNumber, input });
    } catch (error) {
      rows.push({ row: rowNumber, input, error: error instanceof Error ? error.message : 'This row could not be read.' });
    }
  }
  return rows;
}
