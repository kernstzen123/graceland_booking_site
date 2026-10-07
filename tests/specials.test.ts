import { describe, expect, it, vi } from 'vitest';
import { calculateServerTotal, calculateSpecialPrice, DEFAULT_PRICES } from '@/lib/pricing';
import type { BookingSpecialSelection, Special } from '@/lib/specials';

// The special as stored in the database (the live "Family Package").
const familyPackage: Special = {
  id: '11111111-1111-4111-8111-111111111111',
  type: 'tickets_and_meals',
  title: 'Family Package',
  description: null,
  badge_text: null,
  paid_tickets: [{ itemId: 'day-no-water-adult', quantity: 2 }, { itemId: 'day-water-child', quantity: 2 }],
  free_tickets: [],
  pricing: { type: 'fixed-price', price: 660 },
  free_meals: 0,
  included_meals: [{ name: 'Large pizza & 2l coke', quantity: 1 }],
  valid_from: '2026-10-01',
  valid_to: '2026-10-31',
  valid_weekdays: [6, 0],
  stock_limit: 80,
  max_per_booking: 1,
  active: true,
  archived_at: null,
  created_at: '2026-10-01T00:00:00Z',
};

// Supabase stand-in: `from('specials').select('*').in('id', ids)` returns the stored specials.
let storedSpecials: Special[] = [familyPackage];
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: () => ({ select: () => ({ in: (_column: string, ids: string[]) => Promise.resolve({ data: storedSpecials.filter(s => ids.includes(s.id)), error: null }) }) }),
  },
}));

describe('special weekdays (0 = Sunday, as stored by the admin page)', () => {
  it('accepts Sunday as 0 or 7 and treats an empty list as every day', async () => {
    const { specialValidOnWeekday } = await import('@/lib/specials-server');
    expect(specialValidOnWeekday([6, 0], '2026-10-10')).toBe(true); // Saturday
    expect(specialValidOnWeekday([6, 0], '2026-10-11')).toBe(true); // Sunday
    expect(specialValidOnWeekday([7], '2026-10-11')).toBe(true);
    expect(specialValidOnWeekday([6, 0], '2026-10-13')).toBe(false); // Tuesday
    expect(specialValidOnWeekday([], '2026-10-13')).toBe(true);
  });
});

describe('booking specials are priced from the database', () => {
  it('ignores the price, tickets and meals sent by the browser', async () => {
    const { loadBookingSpecials } = await import('@/lib/specials-server');
    const forged = { title: 'x', type: 'discount', pricing: { type: 'fixed-price', price: 0 }, paid_tickets: [], free_tickets: [{ itemId: 'day-water-adult', quantity: 50 }], free_meals: 99, included_meals: [{ name: 'Pizza', quantity: 99 }] };
    const [selection] = await loadBookingSpecials([{ id: familyPackage.id, quantity: 1, snapshot: forged }], '2026-10-11');
    expect(selection.snapshot.pricing).toEqual({ type: 'fixed-price', price: 660 });
    expect(selection.snapshot.free_tickets).toEqual([]);
    expect(selection.snapshot.included_meals).toEqual([{ name: 'Large pizza & 2l coke', quantity: 1 }]);
    const { total, lineItems } = calculateServerTotal({}, undefined, DEFAULT_PRICES, [selection]);
    expect(total).toBeCloseTo(660, 2);
    expect(lineItems.filter(line => line.isPerson).reduce((sum, line) => sum + line.quantity, 0)).toBe(4);
  });

  it('refuses unknown, inactive, archived, out-of-date and over-limit specials', async () => {
    const { loadBookingSpecials, SpecialSelectionError } = await import('@/lib/specials-server');
    await expect(loadBookingSpecials([{ id: '22222222-2222-4222-8222-222222222222', quantity: 1 }], '2026-10-11')).rejects.toBeInstanceOf(SpecialSelectionError);
    await expect(loadBookingSpecials([{ id: familyPackage.id, quantity: 2 }], '2026-10-11')).rejects.toThrow(/at most 1/);
    await expect(loadBookingSpecials([{ id: familyPackage.id, quantity: 0 }], '2026-10-11')).rejects.toThrow(/Invalid special/);
    await expect(loadBookingSpecials([{ id: familyPackage.id, quantity: 1 }], '2026-10-13')).rejects.toThrow(/not available on the selected date/); // Tuesday
    await expect(loadBookingSpecials([{ id: familyPackage.id, quantity: 1 }], '2026-11-07')).rejects.toThrow(/not available on the selected date/); // after valid_to
    storedSpecials = [{ ...familyPackage, archived_at: '2026-10-05T00:00:00Z' }];
    await expect(loadBookingSpecials([{ id: familyPackage.id, quantity: 1 }], '2026-10-11')).rejects.toThrow(/no longer available/);
    storedSpecials = [familyPackage];
  });
});

describe('special price calculation cannot be pushed below zero', () => {
  const tamper = (snapshot: Partial<BookingSpecialSelection['snapshot']>): BookingSpecialSelection => ({
    id: familyPackage.id, quantity: 1,
    snapshot: { title: 'T', type: 'discount', paid_tickets: [{ itemId: 'day-water-adult', quantity: 1 }], free_tickets: [], pricing: { type: 'percentage', discount: 0 }, free_meals: 0, ...snapshot },
  });
  it('ignores negative or unknown ticket lines and caps discounts', () => {
    const adult = DEFAULT_PRICES['day-water-adult'];
    expect(calculateServerTotal({}, undefined, DEFAULT_PRICES, [tamper({ paid_tickets: [{ itemId: 'day-water-adult', quantity: 1 }, { itemId: 'day-water-adult', quantity: -5 }] })]).total).toBeCloseTo(adult, 2);
    expect(calculateServerTotal({}, undefined, DEFAULT_PRICES, [tamper({ free_tickets: [{ itemId: 'not-an-item', quantity: 3 }, { itemId: 'day-water-child', quantity: -2 }] })]).lineItems.length).toBe(1);
    expect(calculateSpecialPrice({ paid_tickets: [{ itemId: 'day-water-adult', quantity: 1 }], pricing: { type: 'percentage', discount: 150 } })).toBe(0);
    expect(calculateSpecialPrice({ paid_tickets: [{ itemId: 'day-water-adult', quantity: 1 }], pricing: { type: 'fixed-off', discount: -100 } })).toBe(adult);
    expect(calculateSpecialPrice({ paid_tickets: [], pricing: { type: 'fixed-price', price: -50 } })).toBe(0);
  });
});
