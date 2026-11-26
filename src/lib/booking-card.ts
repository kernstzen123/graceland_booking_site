/**
 * What the gate scanner shows when a booking's QR code is scanned: who it is,
 * every pass, the hut or table, the names, the total and whether it is paid,
 * and how many people are already checked in. Built from a booking row loaded
 * with BOOKING_CARD_SELECT; free of database calls so it is the same online
 * (from the server) and offline (from the tablet's copy) and can be tested.
 */
import { staffNoteText } from '@/lib/booking-edit';
import { bookingPayment } from '@/lib/daily-summary';
import { compareSpots, spotLabel } from '@/lib/seating';

/** The columns a booking card needs (bookings table, with its customer, items, seating, payments, tickets and meals). */
export const BOOKING_CARD_SELECT = 'id,reference,status,visit_date,party_slot,total_amount,amount_due,voucher_amount_used,payment_method,notes,expires_at,deleted_at,voucher_issued,qr_token,customers(first_name,last_name,phone),booking_items(quantity,metadata,packages(name),huts(name)),booking_spots(venue_spots(number,type)),payments(amount,status),tickets(ticket_uid,status),meal_vouchers(status)';

type One<T> = T | T[] | null | undefined;
type CardItem = { quantity: number; metadata?: { name?: string; itemId?: string; isPerson?: boolean; party?: boolean; attendeeNames?: Array<{ firstName?: string; lastName?: string }> } | null; packages?: One<{ name?: string }>; huts?: One<{ name?: string }> };

export type BookingCardRow = {
  id: string;
  reference: string;
  status: string;
  visit_date: string;
  party_slot: string | null;
  total_amount: number;
  amount_due?: number | null;
  voucher_amount_used?: number | null;
  payment_method?: string | null;
  notes?: string | null;
  expires_at?: string | null;
  deleted_at?: string | null;
  voucher_issued?: boolean | null;
  qr_token?: string | null;
  customers?: One<{ first_name?: string | null; last_name?: string | null; phone?: string | null }>;
  booking_items?: CardItem[] | null;
  booking_spots?: Array<{ venue_spots?: One<{ number: string; type: string }> }> | null;
  payments?: Array<{ amount: number | string; status: string }> | null;
  tickets?: Array<{ ticket_uid: string; status: string }> | null;
  meal_vouchers?: Array<{ status: string }> | null;
};

export type BookingCard = {
  bookingId: string;
  reference: string;
  customerName: string;
  phone: string;
  visitDate: string;
  /** The party's time slot, or null for a day visit. */
  partySlot: string | null;
  status: string;
  /** Still a live booking: paid, or unpaid but holding its places. False when cancelled, deleted, refunded or lapsed. */
  active: boolean;
  /** Each pass or extra with how many, e.g. { name: 'Adult (swimming)', quantity: 2 }. Huts and tables are under seating. */
  passes: Array<{ name: string; quantity: number }>;
  /** e.g. ['Hut 4', 'Table 2']; empty when no hut or table was booked. */
  seating: string[];
  /** The names entered for each person, where given. */
  names: string[];
  total: number;
  paid: number;
  owing: number;
  /** Not paid yet (it may have a deposit): the scanner shows a NOT PAID warning. */
  unpaid: boolean;
  notes: string;
  /** Meal vouchers on the booking (they have their own QR codes for the kitchen). */
  meals: number;
  /** People on the booking (tickets, or the person passes when the tickets are not made yet). */
  people: number;
  checkedIn: number;
};

const first = <T,>(value: One<T>) => (Array.isArray(value) ? value[0] : value) ?? undefined;
const SEATING_ITEMS = new Set(['hut-covered', 'hut-shaded']);

/** Whether a booking can still be used at the gate (paid, or unpaid and still holding its places). */
export function bookingIsActive(row: Pick<BookingCardRow, 'status' | 'expires_at' | 'deleted_at' | 'voucher_issued'>, now = Date.now()) {
  if (row.deleted_at || row.voucher_issued) return false;
  if (['PAID', 'CONFIRMED', 'PAYMENT_PENDING'].includes(row.status)) return true;
  return row.status === 'UNPAID' && Boolean(row.expires_at) && new Date(row.expires_at as string).getTime() > now;
}

export function buildBookingCard(row: BookingCardRow, now = Date.now()): BookingCard {
  const customer = first(row.customers);
  const items = row.booking_items || [];
  const passes = new Map<string, number>();
  for (const item of items) {
    const quantity = Number(item.quantity) || 0;
    const meta = item.metadata || {};
    if (quantity <= 0 || SEATING_ITEMS.has(meta.itemId || '')) continue;
    const name = first(item.packages)?.name || meta.name || first(item.huts)?.name || 'Item';
    // The party's free child entrance lines only exist to issue the children's tickets: the party line already counts them.
    if (meta.party && /child entrance/i.test(name)) continue;
    passes.set(name, (passes.get(name) || 0) + quantity);
  }
  const names = items.flatMap(item => (item.metadata?.attendeeNames || []).map(person => [person.firstName, person.lastName].filter(Boolean).join(' ').trim()).filter(Boolean));
  const spots = (row.booking_spots || []).map(spot => first(spot.venue_spots)).filter((spot): spot is { number: string; type: string } => Boolean(spot?.number));
  const tickets = (row.tickets || []).filter(ticket => ticket.status !== 'CANCELLED');
  const personPasses = items.reduce((sum, item) => sum + (item.metadata?.isPerson || first(item.packages) ? Number(item.quantity) || 0 : 0), 0);
  const { total, paid, owing, unpaid } = bookingPayment(row);
  return {
    bookingId: row.id,
    reference: row.reference,
    customerName: [customer?.first_name, customer?.last_name].filter(Boolean).join(' ').trim() || 'Guest',
    phone: customer?.phone || '',
    visitDate: row.visit_date,
    partySlot: row.party_slot || null,
    status: row.status,
    active: bookingIsActive(row, now),
    passes: [...passes.entries()].map(([name, quantity]) => ({ name, quantity })),
    seating: spots.sort(compareSpots).map(spot => spotLabel(spot.type, spot.number)),
    names,
    total,
    paid,
    owing,
    unpaid,
    notes: staffNoteText(row.notes),
    meals: (row.meal_vouchers || []).filter(meal => meal.status !== 'CANCELLED').length,
    people: tickets.length || personPasses,
    checkedIn: tickets.filter(ticket => ticket.status === 'USED').length,
  };
}

/** Why a booking cannot be checked in right now (shown on the card), or null when it can. */
export function checkInBlocker(card: Pick<BookingCard, 'active' | 'visitDate' | 'people' | 'checkedIn' | 'status'>, today: string): string | null {
  if (!card.active) return ['CANCELLED', 'REFUNDED'].includes(card.status) ? 'This booking has been cancelled.' : 'This booking is cancelled, deleted or was not paid in time.';
  if (card.visitDate !== today) return `This booking is for ${card.visitDate}, not today.`;
  if (card.people > 0 && card.checkedIn >= card.people) return 'Everyone on this booking is already checked in.';
  return null;
}
