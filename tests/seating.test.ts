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
