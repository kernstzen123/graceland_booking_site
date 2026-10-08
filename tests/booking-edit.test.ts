import { describe, expect, it } from 'vitest';
import { BookingEditError, linesChanged, parseEditedItems, seatsNeeded, type StoredLine } from '@/lib/booking-edit';
import { calculateServerTotal, DEFAULT_PRICES, EDITABLE_ITEMS, matchEditableItem } from '@/lib/pricing';
import { buildDailySummary } from '@/lib/daily-summary';

// A party booking as the online booking flow stores it (party lines have no ticket code).
const stored: StoredLine[] = [
  { id: 'l1', quantity: 10, price_per_unit: 200, metadata: { party: true, partySlot: '09:30–11:30', name: 'Kiddy Party Option 1', isPerson: false } },
  { id: 'l2', quantity: 10, price_per_unit: 0, metadata: { party: true, partySlot: '09:30–11:30', name: 'Birthday party child entrance', isPerson: true } },
  { id: 'l3', quantity: 2, price_per_unit: 180, metadata: { party: true, partySlot: '09:30–11:30', name: 'Birthday party adult entrance (swimming)', isPerson: true } },
  // A line typed in by hand with the old edit form.
  { id: 'l4', quantity: 1, price_per_unit: 0, metadata: { name: 'hut 3', isPerson: true } },
];

describe('item catalogue for editing', () => {
  it('recognises every line the online booking flow stores', () => {
    const { lineItems } = calculateServerTotal({ 'day-water-adult': 1, 'hut-covered': 1 }, { enabled: true, option: 'option-2', children: 10, adults: 2, adultsWater: [true, false], additionalChildren: 2, additionalChildrenWater: [true, false], partyPacks: 1, slot: '09:30–11:30' }, DEFAULT_PRICES);
    for (const line of lineItems) {
      // The booking route stores party lines by name only, day lines with their ticket code.
      const metadata = line.party ? { name: line.name } : { itemId: line.itemId, name: line.name };
      expect(matchEditableItem(metadata), line.name).not.toBeNull();
      expect(matchEditableItem(metadata)?.isPerson).toBe(line.isPerson);
    }
    expect(matchEditableItem({ name: 'Birthday party child entrance' })?.isPerson).toBe(true);
    expect(matchEditableItem({ name: 'hut 3' })).toBeNull();
  });
  it('has unique ids and names', () => {
    expect(new Set(EDITABLE_ITEMS.map(item => item.id)).size).toBe(EDITABLE_ITEMS.length);
    expect(new Set(EDITABLE_ITEMS.map(item => item.name.toLowerCase())).size).toBe(EDITABLE_ITEMS.length);
  });
});

describe('editing booking items', () => {
  const edit = [
    { id: 'l1', itemId: 'party-children-option-1', quantity: 10, price_per_unit: 200 },
    { id: 'l2', itemId: 'party-child-entrance', quantity: 10, price_per_unit: 0 },
    { id: 'l3', itemId: 'party-adult-swimming', quantity: 3, price_per_unit: 180 },
    // The hand-typed "hut 3" replaced by a covered hut from the list.
    { id: 'l4', itemId: 'hut-covered', quantity: 1, price_per_unit: 400, name: 'ignored', isPerson: true },
  ];

  it('takes names, ticket codes and flags from the price list, never from the request', () => {
    const lines = parseEditedItems(edit, stored, '09:30–11:30');
    const hut = lines.find(line => line.id === 'l4')!;
    expect(hut.metadata).toEqual({ itemId: 'hut-covered', name: 'Covered Hut (Seating for 14-16)', isPerson: false });
    expect(lines.find(line => line.id === 'l3')!.metadata).toMatchObject({ itemId: 'party-adult-swimming', party: true, partySlot: '09:30–11:30', isPerson: true });
  });

  it('keeps an old hand-typed line unchanged until it is replaced', () => {
    const lines = parseEditedItems([...edit.slice(0, 3), { id: 'l4', itemId: null, quantity: 1, price_per_unit: 0 }], stored, '09:30–11:30');
    expect(lines.find(line => line.id === 'l4')).toMatchObject({ item: null, name: 'hut 3', isPerson: true });
  });

  it('refuses new lines that are not on the price list', () => {
    expect(() => parseEditedItems([...edit, { itemId: null, quantity: 1, price_per_unit: 50 }], stored, null)).toThrow(BookingEditError);
    expect(() => parseEditedItems([...edit, { itemId: 'free-beer', quantity: 1, price_per_unit: 0 }], stored, null)).toThrow(/choose an item from the list/);
    expect(() => parseEditedItems([{ id: 'someone-else', itemId: 'day-water-adult', quantity: 1, price_per_unit: 230 }], stored, null)).toThrow(/does not belong/);
    expect(() => parseEditedItems([{ itemId: 'hut-covered', quantity: 1, price_per_unit: 400 }], stored, null)).toThrow(/entrance ticket/);
  });

  it('works out the seats the items need', () => {
    const lines = parseEditedItems(edit, stored, '09:30–11:30');
    expect(seatsNeeded(lines)).toEqual({ huts: 2, tables: 0 }); // the paid hut plus the party hut
    expect(seatsNeeded(parseEditedItems([{ itemId: 'day-water-adult', quantity: 4, price_per_unit: 230 }, { itemId: 'hut-shaded', quantity: 1, price_per_unit: 250 }], [], null))).toEqual({ huts: 0, tables: 1 });
  });

  it('only reports a change when something changed', () => {
    const same = stored.slice(0, 3).map(line => ({ id: line.id, itemId: matchEditableItem(line.metadata as { name: string })!.id, quantity: line.quantity, price_per_unit: line.price_per_unit }));
    const storedWithCodes = parseEditedItems(same, stored.slice(0, 3), '09:30–11:30').map(line => ({ id: line.id!, quantity: line.quantity, price_per_unit: line.price, metadata: line.metadata }));
    expect(linesChanged(parseEditedItems(same, storedWithCodes, '09:30–11:30'), storedWithCodes)).toBe(false);
    expect(linesChanged(parseEditedItems(edit, stored, '09:30–11:30'), stored)).toBe(true);
  });

  it('edited bookings are counted in the daily summary', () => {
    const lines = parseEditedItems(edit, stored, '09:30–11:30');
    const summary = buildDailySummary([{ party_slot: '09:30–11:30', total_amount: 2940, payment_method: 'IMPORTED', customers: { first_name: 'Sam', last_name: 'Smith' }, booking_items: lines.map(line => ({ quantity: line.quantity, metadata: line.metadata })) }], ['09:30–11:30']);
    const row = summary.parties[0].rows[0];
    expect(row.children).toBe(10);
    expect(row.adults).toBe(3);
    expect(row.total).toBe(13); // the old "hut 3" line no longer counts as a person
  });
});
