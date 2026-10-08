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

// ── How many huts and tables a booking may have (online bookings) ──────────
// Shared by the booking page and the booking API so they always agree. Staff
// bookings (Add booking, walk-ins, imports, edits) are not limited.

/** Each covered hut needs at least this many people in the group. */
export const PEOPLE_PER_HUT = 6;
/** Most covered huts one online booking can take (a party's hut counts). */
export const MAX_HUTS_PER_BOOKING = 3;
/** A shaded table seats this many; a group may take one table per this many people. */
export const PEOPLE_PER_TABLE = 6;

/** Covered huts a group of this size may book online: 6–11 people 1, 12–17 people 2, 18+ people 3. */
export function maxHutsFor(people: number) {
  return Math.max(0, Math.min(MAX_HUTS_PER_BOOKING, Math.floor(people / PEOPLE_PER_HUT)));
}

/** Shaded tables a group of this size may book online (always at least one). */
export function maxTablesFor(people: number) {
  return Math.max(1, Math.ceil(people / PEOPLE_PER_TABLE));
}

// ── When a booking holds a spot ────────────────────────────────────────────
// A birthday party holds its hut only for its time slot, plus this many
// minutes either side to set up and clear it. Day visitors hold a spot all
// day, and shaded tables (which cannot host parties) are always booked all
// day. Two bookings may share a spot when their windows do not overlap, so
// one hut can host the 09:30, 12:00 and 14:30 parties back to back.
// The database applies the same rule (spot_hold_window in
// supabase/migrations/20260930_party_hut_time_slots.sql).

export const PARTY_HUT_BUFFER_MINUTES = 15;
const WHOLE_DAY = { start: 0, end: 24 * 60 };

/** Minutes after midnight, as a half-open range [start, end). */
export type SpotWindow = { start: number; end: number };

const toMinutes = (time: string) => {
  const [hours, minutes] = time.trim().split(':').map(Number);
  return hours * 60 + minutes;
};

/** The part of the visit date a booking holds a spot for. */
export function spotHoldWindow(spotType: string, partySlot: string | null | undefined): SpotWindow {
  const [from, to] = (partySlot || '').split(/[–-]/);
  if (spotType !== 'hut' || !from || !to || !/^\d{1,2}:\d{2}$/.test(from.trim()) || !/^\d{1,2}:\d{2}$/.test(to.trim())) return WHOLE_DAY;
  return { start: toMinutes(from) - PARTY_HUT_BUFFER_MINUTES, end: toMinutes(to) + PARTY_HUT_BUFFER_MINUTES };
}

export function windowsOverlap(a: SpotWindow, b: SpotWindow) {
  return a.start < b.end && b.start < a.end;
}

export const isWholeDay = (window: SpotWindow) => window.start <= 0 && window.end >= 24 * 60;
