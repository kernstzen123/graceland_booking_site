/**
 * The daily summary sheet: one line per paid online booking for a visit date,
 * grouped into the day's birthday-party time slots and the day visitors.
 * Walk-in gate sales are not bookings and are left out.
 */
import { compareSpots } from '@/lib/seating';

export type SummaryItem = { quantity: number; metadata?: { itemId?: string; name?: string; party?: boolean; isPerson?: boolean } | null };
export type SummaryBooking = {
  party_slot: string | null;
  total_amount: number;
  /** 'IMPORTED' for bookings copied from the booking book (paid outside the system). */
  payment_method?: string | null;
  /** Payments on the booking; for an imported booking, the payments staff recorded on it. */
  payments?: Array<{ amount: number | string; status: string }> | null;
  customers?: { first_name?: string | null; last_name?: string | null } | Array<{ first_name?: string | null; last_name?: string | null }> | null;
  booking_items?: SummaryItem[] | null;
  booking_spots?: Array<{ venue_spots?: { number: string; type: string } | Array<{ number: string; type: string }> | null }> | null;
};

export type SummaryCounts = { children: number; toddlers: number; infants: number; adults: number; pensioners: number };
export type SummaryRow = SummaryCounts & { time: string; client: string; total: number; meals: string; seating: string; paid: number; imported: boolean; owing: number };
export type SummarySection = { slot: string; rows: SummaryRow[] };
export type DailySummary = { parties: SummarySection[]; dayVisitors: SummaryRow[] };

const first = <T,>(value: T | T[] | null | undefined) => (Array.isArray(value) ? value[0] : value) ?? undefined;
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
/** "09:30–11:30" → "09:30". */
export const slotStart = (slot: string) => slot.split(/[–-]/)[0].trim();

function countItems(items: SummaryItem[]) {
  const counts: SummaryCounts = { children: 0, toddlers: 0, infants: 0, adults: 0, pensioners: 0 };
  let hotdogs = 0;
  let partyPacks = 0;
  for (const item of items) {
    const quantity = Number(item.quantity) || 0;
    const meta = item.metadata || {};
    const id = meta.itemId || '';
    const name = (meta.name || '').toLowerCase();
    if (meta.party) {
      if (name.includes('party pack')) partyPacks += quantity;
      // The party package line is priced per child; the children are counted on their entrance lines.
      else if (name.startsWith('kiddy party')) { if (name.includes('hotdog')) hotdogs += quantity; }
      else if (name.includes('adult')) counts.adults += quantity;
      else if (name.includes('child')) counts.children += quantity;
    } else if (id.endsWith('-infant')) counts.infants += quantity;
    else if (id.endsWith('-toddler')) counts.toddlers += quantity;
    else if (id.endsWith('-child')) counts.children += quantity;
    else if (id.endsWith('-adult')) counts.adults += quantity;
    else if (id.endsWith('-pensioner')) counts.pensioners += quantity;
  }
  const meals = [hotdogs ? plural(hotdogs, 'hotdog') : '', partyPacks ? plural(partyPacks, 'party pack') : ''].filter(Boolean).join(', ');
  return { counts, meals };
}

function toRow(booking: SummaryBooking): SummaryRow {
  const customer = first(booking.customers);
  const { counts, meals } = countItems(booking.booking_items || []);
  // Imported bookings were paid (or part-paid) outside the system: only the payments recorded on them count.
  const imported = booking.payment_method === 'IMPORTED';
  const paid = imported
    ? Math.round((booking.payments || []).filter(payment => payment.status === 'COMPLETE').reduce((sum, payment) => sum + Number(payment.amount), 0) * 100) / 100
    : Number(booking.total_amount) || 0;
  const spots = (booking.booking_spots || []).map(row => first(row.venue_spots)).filter((spot): spot is { number: string; type: string } => Boolean(spot?.number));
  return {
    time: booking.party_slot ? slotStart(booking.party_slot) : 'DV',
    client: [customer?.first_name, customer?.last_name].filter(Boolean).join(' ').trim() || 'Guest',
    total: counts.children + counts.toddlers + counts.infants + counts.adults + counts.pensioners,
    ...counts,
    meals,
    seating: spots.sort(compareSpots).map(spot => spot.number).join(', '),
    paid,
    imported,
    owing: imported ? Math.max(0, Math.round(((Number(booking.total_amount) || 0) - paid) * 100) / 100) : 0,
  };
}

/**
 * Group a day's paid bookings. `slots` are the party slots offered on that day
 * (shown even when empty); a booking in any other slot still gets its own section.
 */
export function buildDailySummary(bookings: SummaryBooking[], slots: readonly string[]): DailySummary {
  const sections = new Map<string, SummaryRow[]>(slots.map(slot => [slot, []]));
  const dayVisitors: SummaryRow[] = [];
  for (const booking of bookings) {
    const row = toRow(booking);
    if (!booking.party_slot) { dayVisitors.push(row); continue; }
    if (!sections.has(booking.party_slot)) sections.set(booking.party_slot, []);
    sections.get(booking.party_slot)!.push(row);
  }
  const byClient = (a: SummaryRow, b: SummaryRow) => a.client.localeCompare(b.client);
  return {
    parties: [...sections.entries()].sort((a, b) => slotStart(a[0]).localeCompare(slotStart(b[0]))).map(([slot, rows]) => ({ slot, rows: rows.sort(byClient) })),
    dayVisitors: dayVisitors.sort(byClient),
  };
}
