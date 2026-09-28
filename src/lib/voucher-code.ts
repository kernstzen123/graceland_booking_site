/**
 * Voucher codes: new ones look like GRC-7KQ2-M9XA-4TPB (12 random characters);
 * older ones like GRC-1A2B3C4D (8 characters) stay valid.
 */

const OLD_FORMAT = /^GRC-[A-Z0-9]{8}$/;
const NEW_FORMAT = /^GRC-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

/**
 * Tidy what a customer typed: upper case, no spaces, and dashes put back in a
 * new-format code typed without them. Returns '' if it cannot be a voucher code.
 */
export function normalizeVoucherCode(value: unknown): string {
  if (typeof value !== 'string') return '';
  const compact = value.toUpperCase().replace(/[\s-]/g, '');
  if (!compact.startsWith('GRC')) return '';
  const body = compact.slice(3);
  if (!/^[A-Z0-9]+$/.test(body)) return '';
  if (body.length === 8) return `GRC-${body}`;
  if (body.length === 12) return `GRC-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8)}`;
  return '';
}

export function isVoucherCode(value: string) {
  return OLD_FORMAT.test(value) || NEW_FORMAT.test(value);
}
