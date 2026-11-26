/**
 * The handheld (keyboard-mode) QR scanner. Wireless scanners such as the BS220
 * "type" what they read very fast and press Enter, like a keyboard. These
 * helpers turn those key presses back into scans and tell a real scan from a
 * garbled one (the usual cause is the scanner or the tablet keyboard not being
 * set to English (US), which changes characters such as : / ? and =).
 */

/** Longest pause between two characters of one scan; a slower key starts a new scan. */
export const SCAN_KEY_GAP_MS = 400;
/** Shortest value treated as a scan (a ticket ID is about 12 characters). */
export const MIN_SCAN_LENGTH = 6;

export type ScanBuffer = {
  /** Feed a key press. Returns the scanned value when Enter ends a scan, else null. */
  key(key: string, at: number): string | null;
  /** Whether a scan is being typed right now (Enter must then not press a focused button). */
  active(at: number): boolean;
  clear(): void;
};

export function createScanBuffer(): ScanBuffer {
  let value = '';
  let last = 0;
  return {
    key(key, at) {
      if (value && at - last > SCAN_KEY_GAP_MS) value = '';
      last = at;
      if (key === 'Enter' || key === 'Tab') {
        const scanned = value;
        value = '';
        return scanned.length >= MIN_SCAN_LENGTH ? scanned : null;
      }
      if (key.length === 1) value += key;
      return null;
    },
    active(at) {
      return value.length > 0 && at - last <= SCAN_KEY_GAP_MS;
    },
    clear() {
      value = '';
    },
  };
}

export type ScanKind = 'code' | 'meal' | 'garbled';

/** What a scanned value is: a booking or ticket code (or ID / reference), a meal voucher, or something garbled. */
export function classifyScan(raw: string): ScanKind {
  const value = raw.trim();
  if (/^MEAL-/i.test(value)) return 'meal';
  if (/^(TKT|BK)-[A-Z0-9-]+$/i.test(value)) return 'code';
  let token = value;
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      token = url.searchParams.get('token') || '';
    } catch {
      return 'garbled';
    }
  }
  const match = /^([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+$/.exec(token);
  if (!match) return 'garbled';
  try {
    const padded = match[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), '=')));
    return payload?.type === 'meal' ? 'meal' : 'code';
  } catch {
    // Signed codes always carry readable details; anything else was changed on the way in.
    return 'garbled';
  }
}
