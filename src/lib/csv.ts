/**
 * One CSV cell. Text that starts with = + - @ (or a tab/carriage return) is
 * prefixed with ' so Excel and Google Sheets show it as text instead of running
 * it as a formula: a customer could otherwise type "=HYPERLINK(...)" as their
 * name. Plain numbers (amounts, headcounts) are left alone.
 */
export function csvCell(value: unknown) {
  let text = String(value ?? '');
  if (typeof value !== 'number' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
