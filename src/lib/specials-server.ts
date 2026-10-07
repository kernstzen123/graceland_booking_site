import 'server-only';
import { supabase } from '@/lib/supabase';
import { BOOKABLE_ITEMS } from '@/lib/pricing';
import type { BookingSpecialSelection, Special, SpecialItemDef, SpecialSnapshot } from '@/lib/specials';

/** A special that cannot be booked as requested; the message is safe to show the customer. */
export class SpecialSelectionError extends Error {}

/** Statuses of bookings that hold a special's stock (unpaid ones only while their hold lasts). */
export const STOCK_HOLDING_STATUSES = ['CONFIRMED', 'PAID', 'PAYMENT_PENDING', 'UNPAID'] as const;

/**
 * Whether a special can be booked on this weekday. The admin page stores
 * 0 = Sunday … 6 = Saturday; 7 is also accepted as Sunday. Empty = every day.
 */
export function specialValidOnWeekday(weekdays: number[] | null | undefined, date: string) {
  if (!weekdays || weekdays.length === 0) return true;
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return weekdays.includes(day) || (day === 0 && weekdays.includes(7));
}

/** How many of each special are held by bookings on this visit date. */
export async function specialsSoldOn(date: string, specialIds: string[]): Promise<Map<string, number>> {
  const sold = new Map<string, number>();
  if (!specialIds.length) return sold;
  const { data, error } = await supabase
    .from('booking_specials')
    .select('special_id, quantity, bookings!inner(visit_date, status, expires_at)')
    .eq('bookings.visit_date', date)
    .in('bookings.status', [...STOCK_HOLDING_STATUSES])
    .in('special_id', specialIds);
  if (error) throw error;
  const now = Date.now();
  for (const row of data || []) {
    const booking = (Array.isArray(row.bookings) ? row.bookings[0] : row.bookings) as { status: string; expires_at: string | null } | null;
    // An unpaid booking only holds stock until its payment window ends.
    if (!booking || (booking.status === 'UNPAID' && !(booking.expires_at && new Date(booking.expires_at).getTime() > now))) continue;
    sold.set(row.special_id, (sold.get(row.special_id) || 0) + Number(row.quantity || 0));
  }
  return sold;
}

/** Ticket lines from the database, kept only if they are known items with whole positive quantities. */
function cleanTicketLines(lines: unknown): SpecialItemDef[] {
  if (!Array.isArray(lines)) return [];
  return lines
    .map(line => ({ itemId: String((line as SpecialItemDef)?.itemId || ''), quantity: Number((line as SpecialItemDef)?.quantity) }))
    .filter(line => BOOKABLE_ITEMS[line.itemId] && Number.isInteger(line.quantity) && line.quantity > 0);
}

/** The copy of a special stored with a booking, built from the specials table. */
export function snapshotFromSpecial(special: Special): SpecialSnapshot {
  return {
    title: special.title,
    badge_text: special.badge_text || undefined,
    type: special.type,
    paid_tickets: cleanTicketLines(special.paid_tickets),
    free_tickets: cleanTicketLines(special.free_tickets),
    pricing: special.pricing,
    free_meals: Math.max(0, Number(special.free_meals) || 0),
    included_meals: Array.isArray(special.included_meals) ? special.included_meals : [],
  };
}

/**
 * Turn the specials a customer asked for into trusted selections. Only the
 * special's id and quantity are taken from the request; its price, tickets and
 * meals always come from the database, so a changed request cannot alter them.
 * Throws SpecialSelectionError for anything the customer needs to change.
 */
export async function loadBookingSpecials(requested: unknown, visitDate: string): Promise<BookingSpecialSelection[]> {
  if (requested === undefined || requested === null) return [];
  if (!Array.isArray(requested)) throw new SpecialSelectionError('Invalid specials format');

  // Combine repeated entries for the same special.
  const quantities = new Map<string, number>();
  for (const entry of requested.slice(0, 20)) {
    const id = typeof entry?.id === 'string' ? entry.id : '';
    const quantity = Number(entry?.quantity);
    if (!/^[0-9a-f-]{36}$/i.test(id) || !Number.isInteger(quantity) || quantity < 1 || quantity > 100) throw new SpecialSelectionError('Invalid special format');
    quantities.set(id, (quantities.get(id) || 0) + quantity);
  }
  if (!quantities.size) return [];

  const { data, error } = await supabase.from('specials').select('*').in('id', [...quantities.keys()]);
  if (error) throw error;
  const specials = new Map(((data || []) as Special[]).map(special => [special.id, special]));

  const selections: BookingSpecialSelection[] = [];
  for (const [id, quantity] of quantities) {
    const special = specials.get(id);
    if (!special || !special.active || special.archived_at) throw new SpecialSelectionError('A special you selected is no longer available. Please refresh the page and try again.');
    if (special.max_per_booking && quantity > special.max_per_booking) throw new SpecialSelectionError(`You can book at most ${special.max_per_booking} of "${special.title}".`);
    if ((special.valid_from && visitDate < special.valid_from) || (special.valid_to && visitDate > special.valid_to) || !specialValidOnWeekday(special.valid_weekdays, visitDate)) {
      throw new SpecialSelectionError(`"${special.title}" is not available on the selected date.`);
    }
    const snapshot = snapshotFromSpecial(special);
    if (!snapshot.paid_tickets.length && !snapshot.free_tickets.length) throw new SpecialSelectionError(`"${special.title}" is not set up correctly. Please contact us.`);
    selections.push({ id, quantity, snapshot });
  }
  return selections;
}
