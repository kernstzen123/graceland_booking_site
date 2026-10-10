import 'server-only';
import { supabase } from '@/lib/supabase';
import { BOOKABLE_ITEMS, type PriceList } from '@/lib/pricing';
import { autoSpecialSelection, pickAutoSpecial } from '@/lib/special-auto';
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

/** A problem with a special entered by staff; the message is safe to show. */
export class SpecialInputError extends Error {}

const SPECIAL_TYPES = ['discount', 'buy_x_get_y', 'tickets_and_meals'] as const;
const isDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
const optionalText = (value: unknown, max: number) => (typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, max) : '');
const optionalWhole = (value: unknown, label: string) => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 100000) throw new SpecialInputError(`${label} must be a whole number of at least 1, or left empty.`);
  return number;
};

function ticketLinesInput(value: unknown, label: string): SpecialItemDef[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 20) throw new SpecialInputError(`${label} are not valid.`);
  return value.map(line => {
    const itemId = String(line?.itemId || '');
    const quantity = Number(line?.quantity);
    if (!BOOKABLE_ITEMS[itemId]) throw new SpecialInputError(`${label}: choose a ticket type for every line.`);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) throw new SpecialInputError(`${label}: each quantity must be a whole number from 1 to 100.`);
    return { itemId, quantity };
  });
}

/** "Give free to bookings over R…": a rand amount, or empty for off. */
function autoApplyInput(value: unknown): { auto_apply_min_spend?: number } {
  if (value === null || value === undefined || value === '') return {};
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0 || amount > 1000000) throw new SpecialInputError('The amount for giving the special free must be a rand amount, or left empty.');
  return { auto_apply_min_spend: Math.round(amount * 100) / 100 };
}

/** The fields of a special as staff may set them, checked and cleaned. Throws SpecialInputError. */
export function parseSpecialInput(body: Record<string, unknown>) {
  const title = optionalText(body.title, 120);
  if (!title) throw new SpecialInputError('Enter a title.');
  const type = String(body.type || '');
  if (!SPECIAL_TYPES.includes(type as (typeof SPECIAL_TYPES)[number])) throw new SpecialInputError('Choose a special type.');

  const paid_tickets = ticketLinesInput(body.paid_tickets, 'Paid tickets');
  const free_tickets = ticketLinesInput(body.free_tickets, 'Free tickets');
  if (!paid_tickets.length && !free_tickets.length) throw new SpecialInputError('Add at least one ticket to the special.');

  const rawPricing = (body.pricing || {}) as Record<string, unknown>;
  let pricing: Special['pricing'];
  if (rawPricing.type === 'percentage') {
    const discount = Number(rawPricing.discount);
    if (!Number.isFinite(discount) || discount < 0 || discount > 100) throw new SpecialInputError('The % off must be from 0 to 100.');
    pricing = { type: 'percentage', discount };
  } else if (rawPricing.type === 'fixed-off') {
    const discount = Number(rawPricing.discount);
    if (!Number.isFinite(discount) || discount < 0 || discount > 1000000) throw new SpecialInputError('The rand discount is not valid.');
    pricing = { type: 'fixed-off', discount: Math.round(discount * 100) / 100 };
  } else if (rawPricing.type === 'fixed-price') {
    const price = Number(rawPricing.price);
    if (!Number.isFinite(price) || price < 0 || price > 1000000) throw new SpecialInputError('The fixed price is not valid.');
    pricing = { type: 'fixed-price', price: Math.round(price * 100) / 100 };
  } else {
    throw new SpecialInputError('Choose how the special is priced.');
  }

  const freeMeals = Number(body.free_meals ?? 0);
  if (!Number.isInteger(freeMeals) || freeMeals < 0 || freeMeals > 100) throw new SpecialInputError('Free meals must be a whole number from 0 to 100.');
  const rawMeals = body.included_meals ?? [];
  if (!Array.isArray(rawMeals) || rawMeals.length > 20) throw new SpecialInputError('The meal vouchers are not valid.');
  const included_meals = rawMeals.map(meal => {
    const name = optionalText(meal?.name, 80);
    const quantity = Number(meal?.quantity);
    if (!name) throw new SpecialInputError('Give every meal voucher a name.');
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) throw new SpecialInputError(`"${name}": the quantity must be a whole number from 1 to 100.`);
    return { name, quantity };
  });

  const valid_from = body.valid_from ? String(body.valid_from) : null;
  const valid_to = body.valid_to ? String(body.valid_to) : null;
  if ((valid_from && !isDate(valid_from)) || (valid_to && !isDate(valid_to))) throw new SpecialInputError('Enter valid dates.');
  if (valid_from && valid_to && valid_to < valid_from) throw new SpecialInputError('"Valid to" must be on or after "Valid from".');
  const rawWeekdays = body.valid_weekdays ?? [];
  if (!Array.isArray(rawWeekdays)) throw new SpecialInputError('The weekdays are not valid.');
  // Stored as 0 = Sunday … 6 = Saturday; 7 is also read as Sunday.
  const valid_weekdays = [...new Set(rawWeekdays.map(Number).map(day => (day === 7 ? 0 : day)))].sort();
  if (valid_weekdays.some(day => !Number.isInteger(day) || day < 0 || day > 6)) throw new SpecialInputError('The weekdays are not valid.');

  return {
    title,
    description: optionalText(body.description, 1000) || null,
    badge_text: optionalText(body.badge_text, 40) || null,
    type: type as Special['type'],
    paid_tickets,
    free_tickets,
    pricing,
    free_meals: freeMeals,
    included_meals,
    valid_from,
    valid_to,
    valid_weekdays,
    // Only sent when set, so specials can still be saved before 20261012_special_auto_apply.sql is applied.
    ...autoApplyInput(body.auto_apply_min_spend),
    stock_limit: optionalWhole(body.stock_limit, 'The daily stock limit'),
    max_per_booking: optionalWhole(body.max_per_booking, 'Max per booking'),
    active: body.active !== false,
  };
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

/**
 * The special an online booking gets free because its cart is over the
 * special's minimum spend (see src/lib/special-auto.ts), or null. Only specials
 * that are active, valid on the visit date and not sold out that day count;
 * `excludeIds` are specials the customer added themselves.
 */
export async function loadAutoSpecial(visitDate: string, cartTotal: number, prices: PriceList, excludeIds: string[]): Promise<BookingSpecialSelection | null> {
  const { data, error } = await supabase.from('specials').select('*')
    .eq('active', true).is('archived_at', null).not('auto_apply_min_spend', 'is', null)
    .or(`valid_from.is.null,valid_from.lte.${visitDate}`)
    .or(`valid_to.is.null,valid_to.gte.${visitDate}`);
  if (error) {
    // Before 20261012_special_auto_apply.sql the column does not exist: no special applies by itself.
    if (['42703', 'PGRST204'].includes(error.code || '') || /auto_apply_min_spend/.test(error.message || '')) return null;
    throw error;
  }
  const onThisDay = ((data || []) as Special[]).filter(special => specialValidOnWeekday(special.valid_weekdays, visitDate));
  if (!onThisDay.length) return null;
  const sold = await specialsSoldOn(visitDate, onThisDay.filter(special => special.stock_limit !== null).map(special => special.id));
  const candidates = onThisDay.map(special => ({ ...special, remaining: special.stock_limit === null ? null : special.stock_limit - (sold.get(special.id) || 0) }));
  const best = pickAutoSpecial(candidates, cartTotal, prices, excludeIds);
  return best ? autoSpecialSelection(best) : null;
}
