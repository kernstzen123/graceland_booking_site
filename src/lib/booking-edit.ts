/**
 * Rules for editing the items on a booking (used by the admin bookings API).
 * Kept free of database calls so they can be tested on their own.
 */
import { findEditableItem, matchEditableItem, type EditableItem } from '@/lib/pricing';

/** A problem staff can fix in the edit form; the message is safe to show. */
export class BookingEditError extends Error {}

export type StoredLine = { id: string; quantity: number; price_per_unit: number; metadata: Record<string, unknown> | null };

/** One line of the edited booking, ready to save. */
export type EditedLine = {
  id?: string;
  /** null only for an existing hand-typed line that staff kept as it was. */
  item: EditableItem | null;
  name: string;
  quantity: number;
  price: number;
  isPerson: boolean;
  metadata: Record<string, unknown>;
};

const MAX_LINES = 60;

/**
 * Check the edited lines. Each line is either a catalogue item (itemId), or an
 * existing line that is not on the price list, kept unchanged apart from its
 * quantity and price. Names, ticket codes and the person/party flags always
 * come from the catalogue, never from the request.
 */
export function parseEditedItems(raw: unknown, existing: StoredLine[], partySlot: string | null): EditedLine[] {
  if (!Array.isArray(raw)) throw new BookingEditError('The items are not valid.');
  if (raw.length > MAX_LINES) throw new BookingEditError(`A booking can have at most ${MAX_LINES} lines.`);
  const existingById = new Map(existing.map(line => [line.id, line]));
  const seen = new Set<string>();
  const lines = raw.map((entry, index): EditedLine => {
    const id = typeof entry?.id === 'string' && entry.id ? entry.id : undefined;
    if (id && !existingById.has(id)) throw new BookingEditError('An item does not belong to this booking.');
    if (id && seen.has(id)) throw new BookingEditError('An item appears twice.');
    if (id) seen.add(id);
    const quantity = Number(entry?.quantity);
    const price = Number(entry?.price_per_unit);
    const previous = id ? existingById.get(id)! : null;

    const item = findEditableItem(typeof entry?.itemId === 'string' ? entry.itemId : null);
    let name: string; let isPerson: boolean; let metadata: Record<string, unknown>;
    if (item) {
      name = item.name;
      isPerson = item.isPerson;
      // Keep anything else on the line (e.g. attendee names) but set the catalogue fields.
      const kept = { ...(previous?.metadata || {}) };
      delete kept.itemId; delete kept.party; delete kept.partySlot;
      metadata = { ...kept, itemId: item.id, name: item.name, isPerson: item.isPerson, ...(item.party ? { party: true, partySlot } : {}) };
    } else if (previous && entry?.itemId == null && !matchEditableItem(previous.metadata as { itemId?: string; name?: string })) {
      // A line typed in by hand before the dropdowns existed: it may stay as it is until staff replace it.
      name = String(previous.metadata?.name || 'Booking item');
      isPerson = previous.metadata?.isPerson === true;
      metadata = { ...(previous.metadata || {}) };
    } else {
      throw new BookingEditError(`Line ${index + 1}: choose an item from the list.`);
    }
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 500) throw new BookingEditError(`Quantity for "${name}" must be a whole number from 1 to 500.`);
    if (!Number.isFinite(price) || price < 0 || price > 1000000) throw new BookingEditError(`Price for "${name}" is not valid.`);
    return { id, item, name, quantity, price: Math.round(price * 100) / 100, isPerson, metadata };
  });
  if (!lines.length) throw new BookingEditError('A booking needs at least one item.');
  if (!lines.some(line => line.isPerson)) throw new BookingEditError('Add at least one entrance ticket (an item for a person).');
  return lines;
}

/** Huts and tables the items need: paid huts and tables, plus one hut for a birthday party. */
export function seatsNeeded(lines: Array<Pick<EditedLine, 'item' | 'quantity'>>) {
  let huts = 0; let tables = 0; let party = false;
  for (const line of lines) {
    if (line.item?.seat === 'hut') huts += line.quantity;
    if (line.item?.seat === 'table') tables += line.quantity;
    if (line.item?.id.startsWith('party-children-')) party = true;
  }
  return { huts: huts + (party ? 1 : 0), tables };
}

/** Whether the edited lines differ from what is stored (so tickets are only rebuilt when needed). */
export function linesChanged(lines: EditedLine[], existing: StoredLine[]) {
  if (lines.length !== existing.length) return true;
  const byId = new Map(existing.map(line => [line.id, line]));
  return lines.some(line => {
    const stored = line.id ? byId.get(line.id) : undefined;
    return !stored
      || stored.quantity !== line.quantity
      || Number(stored.price_per_unit) !== line.price
      || stored.metadata?.itemId !== line.metadata.itemId
      || stored.metadata?.name !== line.metadata.name
      || (stored.metadata?.isPerson === true) !== line.isPerson;
  });
}

/** A line of booking notes the system writes (IMPORTED_FROM_BOOK, WALK_IN, PAID_BY_VOUCHER, …) rather than staff. */
const isMarkerLine = (line: string) => /^[A-Z_]+$/.test(line.trim());

/**
 * The notes to save after an edit: the system's marker lines are kept as they
 * were (so an imported booking stays recognisable as imported, and so on) and
 * the staff note replaces everything else.
 */
export function editedNotes(existing: string | null | undefined, staffNote: string, markerIfMissing?: string): string | null {
  const markers = (existing || '').split('\n').filter(isMarkerLine).map(line => line.trim());
  if (markerIfMissing && !markers.includes(markerIfMissing)) markers.unshift(markerIfMissing);
  const notes = [...markers, ...(staffNote ? [staffNote] : [])].join('\n');
  return notes || null;
}
