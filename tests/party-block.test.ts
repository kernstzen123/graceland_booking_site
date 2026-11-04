import { describe, expect, it } from 'vitest';
import { getPartySlots, isPartyBlockedDate, nextPartyDate } from '@/lib/parties';
import { getOpeningStatus } from '@/lib/opening-rules';

describe('party block 21 December 2026 to 14 January 2027', () => {
  it('offers no party slots on any day of the block', () => {
    for (const date of ['2026-12-21', '2026-12-22', '2026-12-24', '2026-12-31', '2027-01-02', '2027-01-09', '2027-01-14']) {
      expect(isPartyBlockedDate(date)).toBe(true);
      expect(getPartySlots(date)).toEqual([]);
    }
  });

  it('offers parties again either side of it', () => {
    expect(getPartySlots('2026-12-19')).not.toEqual([]); // Saturday before
    expect(getPartySlots('2027-01-15')).not.toEqual([]); // Friday after
    expect(isPartyBlockedDate('2026-12-20')).toBe(false);
    expect(isPartyBlockedDate('2027-01-15')).toBe(false);
  });

  it('points to 15 January 2027 as the next party date', () => {
    expect(nextPartyDate('2026-12-21')).toBe('2027-01-15');
  });

  it('keeps the days open for day visitors', () => {
    for (const date of ['2026-12-22', '2026-12-27', '2027-01-09', '2027-01-14']) {
      expect(getOpeningStatus(date).open).toBe(true);
    }
  });
});
