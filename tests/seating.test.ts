import { describe, expect, it } from 'vitest';
import { compareSpots, spotLabel } from '@/lib/seating';

describe('seating spots', () => {
  it('labels current and previous-map spots', () => {
    expect(spotLabel('hut', 'H3')).toBe('Hut 3');
    expect(spotLabel('table', 'T12')).toBe('Table 12');
    expect(spotLabel('hut', '5')).toBe('Hut 5');
  });
  it('sorts huts before tables, numerically', () => {
    const spots = [{ type: 'table', number: 'T2' }, { type: 'hut', number: 'H10' }, { type: 'hut', number: 'H2' }, { type: 'table', number: 'T1' }];
    expect([...spots].sort(compareSpots).map(spot => spot.number)).toEqual(['H2', 'H10', 'T1', 'T2']);
  });
});

describe('when a booking holds a spot', () => {
  it('holds a party hut for its slot plus 15 minutes either side', async () => {
    const { spotHoldWindow, windowsOverlap } = await import('@/lib/seating');
    const morning = spotHoldWindow('hut', '09:30–11:30');
    expect(morning).toEqual({ start: 9 * 60 + 15, end: 11 * 60 + 45 });
    expect(windowsOverlap(morning, spotHoldWindow('hut', '12:00–14:00'))).toBe(false);
    expect(windowsOverlap(spotHoldWindow('hut', '12:00–14:00'), spotHoldWindow('hut', '14:30–16:30'))).toBe(false);
    expect(windowsOverlap(spotHoldWindow('hut', '10:30–12:30'), spotHoldWindow('hut', '13:00–15:00'))).toBe(false);
    expect(windowsOverlap(morning, spotHoldWindow('hut', '09:30–11:30'))).toBe(true);
  });
  it('holds day-visitor spots and every table all day', async () => {
    const { spotHoldWindow, windowsOverlap, isWholeDay } = await import('@/lib/seating');
    expect(isWholeDay(spotHoldWindow('hut', null))).toBe(true);
    expect(isWholeDay(spotHoldWindow('table', '09:30–11:30'))).toBe(true);
    expect(windowsOverlap(spotHoldWindow('hut', null), spotHoldWindow('hut', '14:30–16:30'))).toBe(true);
  });
});
