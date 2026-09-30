import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Runs the existing pricing and opening-rules check scripts (scripts/verify-*.ts)
 * as part of the test suite. They call process.exit(1) when a check fails.
 */
async function runScript(path: string) {
  let exitCode: number | undefined;
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { exitCode = code ?? 0; return undefined as never; }) as typeof process.exit);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await import(path);
  } finally {
    exit.mockRestore();
    log.mockRestore();
  }
  return exitCode ?? 0;
}

afterEach(() => vi.resetModules());

describe('business rules', () => {
  it('server pricing matches the booking page for every sample basket', async () => {
    expect(await runScript('../scripts/verify-pricing')).toBe(0);
  });
  it('opening days, hours and holidays are correct', async () => {
    expect(await runScript('../scripts/verify-opening-rules')).toBe(0);
  });
});

describe('booking season', () => {
  it('ends on 30 April of the running season', async () => {
    const { seasonEndDate, voucherExpiryDate } = await import('@/lib/opening-rules');
    expect(seasonEndDate('2026-09-30')).toBe('2027-04-30');
    expect(seasonEndDate('2027-01-15')).toBe('2027-04-30');
    expect(seasonEndDate('2027-04-30')).toBe('2027-04-30');
    // Winter break: the coming season.
    expect(seasonEndDate('2027-06-10')).toBe('2028-04-30');
    expect(voucherExpiryDate('2026-10-03T08:00:00Z')).toBe('2027-04-30');
    // 30 April 23:30 in South Africa is still this season; an hour later is the next.
    expect(voucherExpiryDate('2027-04-30T21:30:00Z')).toBe('2027-04-30');
    expect(voucherExpiryDate('2027-04-30T22:30:00Z')).toBe('2028-04-30');
  });
});
