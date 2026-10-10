import { describe, expect, it } from 'vitest';
import { calculateServerTotal, DEFAULT_PRICES } from '@/lib/pricing';
import { autoSpecialSelection, describeAutoExtras, pickAutoSpecial, type AutoSpecialCandidate } from '@/lib/special-auto';

const special = (id: string, extra: Partial<AutoSpecialCandidate>): AutoSpecialCandidate => ({
  id, title: `Special ${id}`, type: 'tickets_and_meals', free_tickets: [], free_meals: 0, included_meals: [], auto_apply_min_spend: 660, remaining: null, ...extra,
});
const meals = special('meals', { included_meals: [{ name: 'Hotdog', quantity: 2 }] });
const adult = special('adult', { free_tickets: [{ itemId: 'day-water-adult', quantity: 1 }] });

describe('specials given free over a minimum spend', () => {
  it('only apply when the cart is over the amount', () => {
    expect(pickAutoSpecial([meals], 660, DEFAULT_PRICES)).toBeNull();
    expect(pickAutoSpecial([meals], 660.01, DEFAULT_PRICES)?.id).toBe('meals');
  });

  it('are off unless an amount is set', () => {
    expect(pickAutoSpecial([{ ...meals, auto_apply_min_spend: null }], 5000, DEFAULT_PRICES)).toBeNull();
  });

  it('give only the one worth the most', () => {
    expect(pickAutoSpecial([meals, adult], 1000, DEFAULT_PRICES)?.id).toBe('adult');
  });

  it('skip specials the customer added themselves, sold out ones, and ones with no free extras', () => {
    expect(pickAutoSpecial([meals, adult], 1000, DEFAULT_PRICES, ['adult'])?.id).toBe('meals');
    expect(pickAutoSpecial([{ ...adult, remaining: 0 }], 1000, DEFAULT_PRICES)).toBeNull();
    expect(pickAutoSpecial([special('discount', { type: 'discount' })], 1000, DEFAULT_PRICES)).toBeNull();
    // A free hut needs a seat on the map, so it is never given away by itself.
    expect(pickAutoSpecial([special('hut', { free_tickets: [{ itemId: 'hut-covered', quantity: 1 }] })], 1000, DEFAULT_PRICES)).toBeNull();
  });

  it('add the free tickets and meals at R0 without changing the total', () => {
    const selections = { 'day-water-adult': 2, 'day-water-child': 2 };
    const before = calculateServerTotal(selections, undefined, DEFAULT_PRICES);
    const after = calculateServerTotal(selections, undefined, DEFAULT_PRICES, [autoSpecialSelection({ ...adult, included_meals: [{ name: 'Hotdog', quantity: 2 }] })]);
    expect(before.total).toBe(880);
    expect(after.total).toBe(880);
    const added = after.lineItems.filter(line => line.specialId === 'adult');
    expect(added.map(line => [line.name, line.quantity, line.subtotal, line.specialRole])).toEqual([
      ['Adult (including water activities) (Free with Special adult)', 1, 0, 'free'],
      ['Hotdog - meal voucher (Special adult)', 2, 0, 'meal'],
    ]);
    expect(describeAutoExtras({ ...adult, included_meals: [{ name: 'Hotdog', quantity: 2 }] })).toBe('1× Adult (including water activities) and 2× Hotdog');
  });
});
