import { describe, expect, it } from 'vitest';
import { safeNextPath, DEFAULT_STAFF_REDIRECT } from '@/lib/safe-redirect';
import { csvCell } from '@/lib/csv';
import { isVoucherCode, normalizeVoucherCode } from '@/lib/voucher-code';
import { customerError, customerErrorStatus } from '@/lib/public-errors';
import { maskVoucherCode, redactAuditDetails } from '@/lib/admin-auth';
import { createQrToken, verifyQrToken } from '@/lib/qr-token';
import { scrubEvent } from '@/lib/sentry-scrub';
import { startOfJohannesburgDay } from '@/lib/opening-rules';
import type { ErrorEvent } from '@sentry/nextjs';

const ORIGIN = 'https://graceland.example';

describe('sign-in redirect (open redirect protection)', () => {
  it.each([
    ['/admin/set-password', '/admin/set-password'],
    ['/admin', '/admin'],
    ['/admin/bookings?q=1#x', '/admin/bookings?q=1#x'],
  ])('allows %s', (input, expected) => expect(safeNextPath(input, ORIGIN)).toBe(expected));

  it.each(['//evil.com', 'https://evil.com/admin', '/\\evil.com', '/\t/evil.com', 'javascript:alert(1)', '/admin/../evil', '/administrator', '', null, '/%2F%2Fevil.com'])(
    'rejects %j', input => expect(safeNextPath(input, ORIGIN)).toBe(DEFAULT_STAFF_REDIRECT),
  );
});

describe('CSV export cells', () => {
  it('neutralises spreadsheet formulas', () => {
    expect(csvCell('=HYPERLINK("http://x","y")')).toBe('"\'=HYPERLINK(""http://x"",""y"")"');
    for (const start of ['+', '-', '@', '\t', '\r']) expect(csvCell(`${start}1`)).toBe(`"'${start}1"`);
  });
  it('leaves normal text and numbers alone', () => {
    expect(csvCell('Jane Smith')).toBe('"Jane Smith"');
    expect(csvCell(-12.5)).toBe('"-12.5"');
    expect(csvCell(null)).toBe('""');
  });
});

describe('voucher codes', () => {
  it('normalises what customers type', () => {
    expect(normalizeVoucherCode(' grc-1a2b3c4d ')).toBe('GRC-1A2B3C4D');
    expect(normalizeVoucherCode('GRC7KQ2M9XA4TPB')).toBe('GRC-7KQ2-M9XA-4TPB');
    expect(normalizeVoucherCode('grc-7kq2 m9xa-4tpb')).toBe('GRC-7KQ2-M9XA-4TPB');
    expect(normalizeVoucherCode('ABC-12345678')).toBe('');
    expect(normalizeVoucherCode(42)).toBe('');
  });
  it('accepts old and new formats only', () => {
    expect(isVoucherCode('GRC-1A2B3C4D')).toBe(true);
    expect(isVoucherCode('GRC-7KQ2-M9XA-4TPB')).toBe(true);
    expect(isVoucherCode('GRC-1A2B')).toBe(false);
  });
  it('masks codes for the audit log', () => {
    expect(maskVoucherCode('GRC-1A2B3C4D')).toBe('GRC-****3C4D');
    expect(maskVoucherCode('GRC-7KQ2-M9XA-4TPB')).toBe('GRC-****4TPB');
    expect(redactAuditDetails({ credit_code: 'GRC-1A2B3C4D', code: 'GRC-7KQ2-M9XA-4TPB', amount: 10 })).toEqual({ credit_code: 'GRC-****3C4D', code: 'GRC-****4TPB', amount: 10 });
  });
});

describe('customer-facing errors', () => {
  it('shows safe validation messages with 400', () => {
    const error = new Error('Covered huts require a minimum of 6 people.');
    expect(customerError(error, 'fallback')).toBe(error.message);
    expect(customerErrorStatus(error)).toBe(400);
  });
  it('maps capacity and seat conflicts to 409', () => {
    expect(customerErrorStatus({ message: 'Capacity exceeded. Only 3 spots left.' })).toBe(409);
    expect(customerError({ message: 'Capacity exceeded. Only 3 spots left.' }, 'x')).toMatch(/This date is full/);
    expect(customerErrorStatus(new Error('This seating spot was just taken. Please choose another spot.'))).toBe(409);
  });
  it('hides internal errors', () => {
    const error = new Error('relation "bookings" does not exist');
    expect(customerError(error, 'fallback')).toBe('fallback');
    expect(customerErrorStatus(error)).toBe(500);
  });
});

describe('ticket QR tokens', () => {
  const future = '2099-01-01';
  it('verifies a token it created', () => {
    const token = createQrToken('booking-1', 'TKT-ABC', future);
    expect(verifyQrToken(token)).toMatchObject({ bid: 'booking-1', tid: 'TKT-ABC' });
  });
  it('rejects tampered and expired tokens', () => {
    const token = createQrToken('booking-1', 'TKT-ABC', future);
    const [payload, signature] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), bid: 'other' })).toString('base64url');
    expect(verifyQrToken(`${forged}.${signature}`)).toBeNull();
    expect(verifyQrToken(createQrToken('booking-1', 'TKT-ABC', '2000-01-01'))).toBeNull();
    expect(verifyQrToken('not-a-token')).toBeNull();
  });
});

describe('Sentry scrubbing', () => {
  it('removes request data, identity and query strings', () => {
    const event = scrubEvent({
      type: undefined,
      message: 'failed for jane@example.com',
      request: { url: 'https://x/admin/scanner?token=secret', data: { email: 'a@b.co' }, cookies: { sb: 'x' }, query_string: 'token=secret', headers: { Authorization: 'Bearer x', 'user-agent': 'UA' } },
      user: { email: 'jane@example.com' },
      exception: { values: [{ value: 'Booking for jane@example.com' }] },
    } as ErrorEvent);
    expect(event.request).toEqual({ url: 'https://x/admin/scanner', headers: { 'user-agent': 'UA' } });
    expect(event.user).toBeUndefined();
    expect(event.message).toBe('failed for [email]');
    expect(event.exception?.values?.[0].value).toBe('Booking for [email]');
  });
});

describe('South African day boundaries', () => {
  it('starts a day at 22:00 UTC the day before', () => {
    expect(startOfJohannesburgDay('2026-09-28')).toBe('2026-09-27T22:00:00.000Z');
    expect(startOfJohannesburgDay('2026-12-31', 1)).toBe('2026-12-31T22:00:00.000Z');
  });
});
