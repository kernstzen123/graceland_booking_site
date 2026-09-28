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
