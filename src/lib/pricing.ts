/**
 * Single source of truth for Graceland Venues pricing.
 *
 * Imported by the booking API route (server), the PackageSelection component
 * (client) and the party total helper (shared).  Keeping every price in one
 * file guarantees the client total always matches the server total.
 */

import type { PartyDetails } from './parties';

// ---------------------------------------------------------------------------
// Bookable items (day-visitor packages + huts)
// ---------------------------------------------------------------------------

export type BookableItem = {
  name: string;
  price: number;
  isPerson: boolean;
};

export const BOOKABLE_ITEMS: Record<string, BookableItem> = {
  'day-water-infant':      { name: 'Children under 1 (including water activities)',   price: 0,   isPerson: true  },
  'day-water-toddler':     { name: 'Toddlers 1-2 (including water activities)',       price: 110, isPerson: true  },
  'day-water-child':       { name: 'Children 3-17 (including water activities)',       price: 210, isPerson: true  },
  'day-water-adult':       { name: 'Adult (including water activities)',               price: 230, isPerson: true  },
  'day-water-pensioner':   { name: 'Pensioner (including water activities)',           price: 200, isPerson: true  },
  'day-no-water-infant':   { name: 'Children under 1 (excluding water activities)',   price: 0,   isPerson: true  },
  'day-no-water-toddler':  { name: 'Toddlers 1-2 (excluding water activities)',       price: 0,   isPerson: true  },
  'day-no-water-child':    { name: 'Children 3-17 (excluding water activities)',       price: 100, isPerson: true  },
  'day-no-water-adult':    { name: 'Adult (excluding water activities)',               price: 120, isPerson: true  },
  'day-no-water-pensioner':{ name: 'Pensioner (excluding water activities)',           price: 100, isPerson: true  },
  'hut-covered':           { name: 'Covered Hut (Seating for 14-16)',                 price: 400, isPerson: false },
  'hut-shaded':            { name: 'Shaded Table (Seating for 6)',                    price: 250, isPerson: false },
};

// ---------------------------------------------------------------------------
// Party rate constants
// ---------------------------------------------------------------------------

export const PARTY_CHILD_RATE_OPTION_1 = 200;
export const PARTY_CHILD_RATE_OPTION_2 = 225;
export const PARTY_SWIMMING_ADULT_RATE = 180;
export const PARTY_NON_SWIMMING_ADULT_RATE = 80;
export const PARTY_ADDITIONAL_SWIMMING_CHILD_RATE = 200;
export const PARTY_ADDITIONAL_NON_SWIMMING_CHILD_RATE = 100;
export const PARTY_PACK_RATE = 50;

// ---------------------------------------------------------------------------
// Client-facing package groups (derived from BOOKABLE_ITEMS)
// ---------------------------------------------------------------------------

export const PACKAGE_GROUPS = [
  {
    category: 'DAY VISITOR — INCLUDING WATER ACTIVITIES',
    items: ['day-water-infant', 'day-water-toddler', 'day-water-child', 'day-water-adult', 'day-water-pensioner']
      .map(id => ({ id, name: BOOKABLE_ITEMS[id].name.replace(/ \(.*\)$/, ''), price: BOOKABLE_ITEMS[id].price })),
  },
  {
    category: 'DAY VISITOR — EXCLUDING WATER ACTIVITIES',
    items: ['day-no-water-infant', 'day-no-water-toddler', 'day-no-water-child', 'day-no-water-adult', 'day-no-water-pensioner']
      .map(id => ({ id, name: BOOKABLE_ITEMS[id].name.replace(/ \(.*\)$/, ''), price: BOOKABLE_ITEMS[id].price })),
  },
  {
    category: 'DAY VISITOR HUTS',
    items: ['hut-covered', 'hut-shaded']
      .map(id => ({ id, name: BOOKABLE_ITEMS[id].name, price: BOOKABLE_ITEMS[id].price })),
  },
];

// ---------------------------------------------------------------------------
// Party total calculation (pure function)
// ---------------------------------------------------------------------------

export function calculatePartyTotalFromPricing(party: PartyDetails): number {
  if (!party.enabled) return 0;
  const childRate = party.option === 'option-2' ? PARTY_CHILD_RATE_OPTION_2 : PARTY_CHILD_RATE_OPTION_1;
  const swimmingAdults = party.adultsWater.filter(Boolean).length;
  const nonSwimmingAdults = Math.max(0, party.adults - swimmingAdults);
  const swimmingChildren = party.additionalChildrenWater.filter(Boolean).length;
  const nonSwimmingChildren = Math.max(0, party.additionalChildren - swimmingChildren);
  return (
    party.children * childRate +
    swimmingAdults * PARTY_SWIMMING_ADULT_RATE +
    nonSwimmingAdults * PARTY_NON_SWIMMING_ADULT_RATE +
    swimmingChildren * PARTY_ADDITIONAL_SWIMMING_CHILD_RATE +
    nonSwimmingChildren * PARTY_ADDITIONAL_NON_SWIMMING_CHILD_RATE +
    party.partyPacks * PARTY_PACK_RATE
  );
}

// ---------------------------------------------------------------------------
// Server-side total calculation
// ---------------------------------------------------------------------------

export type LineItem = {
  itemId: string;
  name: string;
  quantity: number;
  pricePerUnit: number;
  subtotal: number;
  isPerson: boolean;
  party: boolean;
};

/**
 * Compute the authoritative total from the user's selections and party details.
 * This is used on the server to verify the client total and to pass to
 * reserve_capacity.
 */
export function calculateServerTotal(
  selections: Record<string, number>,
  party: PartyDetails | undefined,
): { lineItems: LineItem[]; total: number } {
  const lineItems: LineItem[] = [];

  // Package / hut items
  for (const [itemId, quantity] of Object.entries(selections)) {
    const qty = Number(quantity);
    if (qty <= 0) continue;
    const item = BOOKABLE_ITEMS[itemId];
    if (!item) continue; // unknown items are rejected by the caller
    lineItems.push({
      itemId,
      name: item.name,
      quantity: qty,
      pricePerUnit: item.price,
      subtotal: item.price * qty,
      isPerson: item.isPerson,
      party: false,
    });
  }

  // Party items
  if (party?.enabled) {
    const childRate = party.option === 'option-2' ? PARTY_CHILD_RATE_OPTION_2 : PARTY_CHILD_RATE_OPTION_1;
    const children = party.children;
    const adults = party.adults;
    const additionalChildren = party.additionalChildren;
    const swimmingAdults = party.adultsWater.filter(Boolean).slice(0, adults).length;
    const nonSwimmingAdults = adults - swimmingAdults;
    const swimmingChildren = party.additionalChildrenWater.filter(Boolean).slice(0, additionalChildren).length;
    const nonSwimmingChildren = additionalChildren - swimmingChildren;

    // Party children (the main party package)
    lineItems.push({
      itemId: 'party-children',
      name: party.option === 'option-2' ? 'Kiddy Party Option 2 (hotdog included)' : 'Kiddy Party Option 1',
      quantity: children,
      pricePerUnit: childRate,
      subtotal: children * childRate,
      isPerson: false,
      party: true,
    });

    // Swimming adults
    if (swimmingAdults > 0) {
      lineItems.push({
        itemId: 'party-adult-swimming',
        name: 'Birthday party adult entrance (swimming)',
        quantity: swimmingAdults,
        pricePerUnit: PARTY_SWIMMING_ADULT_RATE,
        subtotal: swimmingAdults * PARTY_SWIMMING_ADULT_RATE,
        isPerson: true,
        party: true,
      });
    }

    // Non-swimming adults
    if (nonSwimmingAdults > 0) {
      lineItems.push({
        itemId: 'party-adult-non-swimming',
        name: 'Birthday party adult entrance (non-swimming)',
        quantity: nonSwimmingAdults,
        pricePerUnit: PARTY_NON_SWIMMING_ADULT_RATE,
        subtotal: nonSwimmingAdults * PARTY_NON_SWIMMING_ADULT_RATE,
        isPerson: true,
        party: true,
      });
    }

    // Additional swimming children
    if (swimmingChildren > 0) {
      lineItems.push({
        itemId: 'party-child-swimming',
        name: 'Additional birthday party child entrance (swimming)',
        quantity: swimmingChildren,
        pricePerUnit: PARTY_ADDITIONAL_SWIMMING_CHILD_RATE,
        subtotal: swimmingChildren * PARTY_ADDITIONAL_SWIMMING_CHILD_RATE,
        isPerson: true,
        party: true,
      });
    }

    // Additional non-swimming children
    if (nonSwimmingChildren > 0) {
      lineItems.push({
        itemId: 'party-child-non-swimming',
        name: 'Additional birthday party child entrance (non-swimming)',
        quantity: nonSwimmingChildren,
        pricePerUnit: PARTY_ADDITIONAL_NON_SWIMMING_CHILD_RATE,
        subtotal: nonSwimmingChildren * PARTY_ADDITIONAL_NON_SWIMMING_CHILD_RATE,
        isPerson: true,
        party: true,
      });
    }

    // Party packs
    if (party.partyPacks > 0) {
      lineItems.push({
        itemId: 'party-pack',
        name: 'Optional party pack',
        quantity: party.partyPacks,
        pricePerUnit: PARTY_PACK_RATE,
        subtotal: party.partyPacks * PARTY_PACK_RATE,
        isPerson: false,
        party: true,
      });
    }
  }

  const total = lineItems.reduce((sum, item) => sum + item.subtotal, 0);
  return { lineItems, total };
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const MAX_PARTY_FIELD = 500;

function requireNonNegativeInt(value: unknown, fieldName: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`Invalid party field: ${fieldName} must be a non-negative integer`);
  if (n > MAX_PARTY_FIELD) throw new Error(`Invalid party field: ${fieldName} exceeds maximum (${MAX_PARTY_FIELD})`);
  return n;
}

/**
 * Validate and sanitize party details. Returns a clean copy with all numeric
 * fields coerced to integers and boolean arrays trimmed to their respective
 * counts.
 */
export function validatePartyFields(party: PartyDetails): PartyDetails {
  const children = requireNonNegativeInt(party.children, 'children');
  const adults = requireNonNegativeInt(party.adults, 'adults');
  const additionalChildren = requireNonNegativeInt(party.additionalChildren, 'additionalChildren');
  const partyPacks = requireNonNegativeInt(party.partyPacks, 'partyPacks');

  if (!Array.isArray(party.adultsWater)) throw new Error('Invalid party field: adultsWater must be an array');
  if (!Array.isArray(party.additionalChildrenWater)) throw new Error('Invalid party field: additionalChildrenWater must be an array');

  // Trim boolean arrays and verify each element is boolean
  const adultsWater = party.adultsWater.slice(0, adults).map((v, i) => {
    if (typeof v !== 'boolean') throw new Error(`Invalid party field: adultsWater[${i}] must be a boolean`);
    return v;
  });
  const additionalChildrenWater = party.additionalChildrenWater.slice(0, additionalChildren).map((v, i) => {
    if (typeof v !== 'boolean') throw new Error(`Invalid party field: additionalChildrenWater[${i}] must be a boolean`);
    return v;
  });

  return {
    enabled: party.enabled === true,
    option: party.option,
    children,
    adults,
    adultsWater,
    additionalChildren,
    additionalChildrenWater,
    partyPacks,
    slot: party.slot,
  };
}
