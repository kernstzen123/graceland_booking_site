/**
 * Specials that apply by themselves: a special with "auto_apply_min_spend" set
 * gives its free extras (its free entrance tickets and meal vouchers, at R0)
 * to an online booking whose cart total is that amount or more, on a date the
 * special is valid. The customer's own tickets stay at their normal price.
 * When several qualify, only the one worth the most is given.
 *
 * Shared by the booking page (to show the customer) and the booking API (which
 * decides; the browser never sends the free special).
 */
import { BOOKABLE_ITEMS, priceOf, type PriceList } from './pricing';
import type { BookingSpecialSelection, Special, SpecialItemDef } from './specials';

export type AutoSpecialCandidate = Pick<Special, 'id' | 'title' | 'type' | 'free_tickets' | 'free_meals' | 'included_meals'>
  & { badge_text?: string | null; auto_apply_min_spend?: number | string | null; remaining?: number | null };

/** Free entrance tickets only: a hut or table needs a seat on the map, so it is never given away automatically. */
const freeTickets = (lines: SpecialItemDef[] | null | undefined) => (Array.isArray(lines) ? lines : [])
  .filter(line => BOOKABLE_ITEMS[line?.itemId]?.isPerson && Number.isInteger(Number(line.quantity)) && Number(line.quantity) > 0)
  .map(line => ({ itemId: line.itemId, quantity: Number(line.quantity) }));

const freeMeals = (special: AutoSpecialCandidate) => (Array.isArray(special.included_meals) && special.included_meals.length
  ? special.included_meals.filter(meal => meal?.name && Number(meal.quantity) > 0).map(meal => ({ name: meal.name, quantity: Number(meal.quantity) }))
  : Number(special.free_meals) > 0 ? [{ name: 'Free Meal', quantity: Number(special.free_meals) }] : []);

/** The minimum spend that switches the special on, or null when it does not apply by itself. */
export function autoApplyMinSpend(special: Pick<AutoSpecialCandidate, 'auto_apply_min_spend'>) {
  const value = special.auto_apply_min_spend;
  if (value === null || value === undefined || value === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

/**
 * The special to give for this cart, or null. `excludeIds` are specials the
 * customer already added themselves. Candidates must already be valid for the
 * visit date (active, dates, weekdays); `remaining` (stock left that day) is
 * respected when present.
 */
export function pickAutoSpecial<T extends AutoSpecialCandidate>(candidates: T[], cartTotal: number, prices: PriceList, excludeIds: string[] = []): T | null {
  let best: T | null = null;
  let bestValue = -1;
  let bestMeals = -1;
  for (const special of candidates) {
    const minSpend = autoApplyMinSpend(special);
    // R660 or more (a cent of rounding is allowed for).
    if (minSpend === null || !(cartTotal >= minSpend - 0.005)) continue;
    if (excludeIds.includes(special.id)) continue;
    if (special.remaining !== null && special.remaining !== undefined && special.remaining < 1) continue;
    const tickets = freeTickets(special.free_tickets);
    const meals = freeMeals(special);
    if (!tickets.length && !meals.length) continue;
    const value = tickets.reduce((sum, line) => sum + priceOf(prices, line.itemId) * line.quantity, 0);
    const mealCount = meals.reduce((sum, meal) => sum + meal.quantity, 0);
    if (value > bestValue || (value === bestValue && mealCount > bestMeals)) { best = special; bestValue = value; bestMeals = mealCount; }
  }
  return best;
}

/** The special as it is added to the booking: one of it, with only its free tickets and meals (all R0). */
export function autoSpecialSelection(special: AutoSpecialCandidate): BookingSpecialSelection {
  return {
    id: special.id,
    quantity: 1,
    snapshot: {
      title: special.title,
      badge_text: special.badge_text || undefined,
      type: special.type,
      paid_tickets: [],
      free_tickets: freeTickets(special.free_tickets),
      pricing: { type: 'fixed-off', discount: 0 },
      free_meals: 0,
      included_meals: freeMeals(special),
    },
  };
}

/** "1× Adult (including water activities) and 2× Free Meal" for showing the customer. */
export function describeAutoExtras(special: AutoSpecialCandidate) {
  const parts = [
    ...freeTickets(special.free_tickets).map(line => `${line.quantity}× ${BOOKABLE_ITEMS[line.itemId].name}`),
    ...freeMeals(special).map(meal => `${meal.quantity}× ${meal.name}`),
  ];
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0] || '';
}
