/**
 * Seating spots on the venue map. Current spots are numbered H1–H16 (covered
 * huts) and T1–T12 (shaded tables); spots from the previous map were numbered
 * 1–28 and are only still shown on bookings made before the map changed.
 */

export type SpotType = 'hut' | 'table';

/** "Hut 1", "Table 12" (and "Hut 5" for a spot from the previous map). */
export function spotLabel(type: string, number: string | number) {
  const plain = String(number).replace(/^[HT](?=\d)/i, '');
  return `${type === 'table' ? 'Table' : 'Hut'} ${plain}`;
}

/** Sort huts before tables, then by number, so H2 comes before H10. */
export function compareSpots(a: { type: string; number: string }, b: { type: string; number: string }) {
  if (a.type !== b.type) return a.type === 'hut' ? -1 : 1;
  return a.number.localeCompare(b.number, undefined, { numeric: true });
}
