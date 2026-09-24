/**
 * Single source of truth for Graceland Venues pricing.
 *
 * Imported by the booking API route (server), the PackageSelection component
 * (client) and the party total helper (shared).  Every calculation takes a
 * PriceList so the client and the server price a booking identically.
 *
 * DEFAULT_PRICES are charged unless an admin has overridden a price in the
 * admin panel. Overrides live in the price_settings table, are loaded on the
 * server by src/lib/price-store.ts and are served to the browser by /api/prices.
 */

import type { PartyDetails } from './parties';

// ---------------------------------------------------------------------------
// Price keys and defaults
// ---------------------------------------------------------------------------

export type PriceList = Record<string, number>;

export type PriceDefinition = {
  key: string;
  label: string;
  group: string;
  defaultPrice: number;
};

const WATER = 'Day visitor — including water activities';
const NO_WATER = 'Day visitor — excluding water activities';
const HUTS = 'Huts and tables';
const PARTIES = 'Birthday parties';

/** Every price an admin can change, in the order the admin panel lists them. */
export const PRICE_DEFINITIONS: PriceDefinition[] = [
  { key: 'day-water-infant',         group: WATER,    label: 'Children under 1',                      defaultPrice: 0 },
  { key: 'day-water-toddler',        group: WATER,    label: 'Toddlers 1-2',                          defaultPrice: 110 },
  { key: 'day-water-child',          group: WATER,    label: 'Children 3-17',                         defaultPrice: 210 },
  { key: 'day-water-adult',          group: WATER,    label: 'Adult',                                 defaultPrice: 230 },
  { key: 'day-water-pensioner',      group: WATER,    label: 'Pensioner',                             defaultPrice: 200 },
  { key: 'day-no-water-infant',      group: NO_WATER, label: 'Children under 1',                      defaultPrice: 0 },
  { key: 'day-no-water-toddler',     group: NO_WATER, label: 'Toddlers 1-2',                          defaultPrice: 0 },
  { key: 'day-no-water-child',       group: NO_WATER, label: 'Children 3-17',                         defaultPrice: 100 },
  { key: 'day-no-water-adult',       group: NO_WATER, label: 'Adult',                                 defaultPrice: 120 },
  { key: 'day-no-water-pensioner',   group: NO_WATER, label: 'Pensioner',                             defaultPrice: 100 },
  { key: 'hut-covered',              group: HUTS,     label: 'Covered Hut (seats 14-16)',             defaultPrice: 400 },
  { key: 'hut-shaded',               group: HUTS,     label: 'Shaded Table (seats 6)',                defaultPrice: 250 },
  { key: 'party-child-option-1',     group: PARTIES,  label: 'Party child — Option 1',                defaultPrice: 200 },
  { key: 'party-child-option-2',     group: PARTIES,  label: 'Party child — Option 2 (with hotdog)',  defaultPrice: 225 },
  { key: 'party-adult-swimming',     group: PARTIES,  label: 'Party adult (swimming)',                defaultPrice: 180 },
  { key: 'party-adult-non-swimming', group: PARTIES,  label: 'Party adult (non-swimming)',            defaultPrice: 80 },
  { key: 'party-child-swimming',     group: PARTIES,  label: 'Additional party child (swimming)',     defaultPrice: 200 },
  { key: 'party-child-non-swimming', group: PARTIES,  label: 'Additional party child (non-swimming)', defaultPrice: 100 },
  { key: 'party-pack',               group: PARTIES,  label: 'Party pack',                            defaultPrice: 50 },
];

export const DEFAULT_PRICES: PriceList = Object.fromEntries(PRICE_DEFINITIONS.map(def => [def.key, def.defaultPrice]));

export const MAX_PRICE = 100000;

/** Look up a price, falling back to the default for any key missing from the list. */
export function priceOf(prices: PriceList, key: string): number {
  const value = prices[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_PRICES[key] ?? 0;
}

/** Merge stored overrides onto the defaults, ignoring unknown keys and invalid values. */
export function mergePrices(overrides: Array<{ key: string; price: number | string }>): PriceList {
  const prices: PriceList = { ...DEFAULT_PRICES };
  for (const row of overrides) {
    const price = Number(row.price);
    if (row.key in DEFAULT_PRICES && Number.isFinite(price) && price >= 0 && price <= MAX_PRICE) prices[row.key] = price;
  }
  return prices;
}

// ---------------------------------------------------------------------------
// Bookable items (day-visitor packages + huts)
// ---------------------------------------------------------------------------

export type BookableItem = {
  name: string;
  isPerson: boolean;
};

export const BOOKABLE_ITEMS: Record<string, BookableItem> = {
  'day-water-infant':      { name: 'Children under 1 (including water activities)',   isPerson: true  },
  'day-water-toddler':     { name: 'Toddlers 1-2 (including water activities)',       isPerson: true  },
  'day-water-child':       { name: 'Children 3-17 (including water activities)',       isPerson: true  },
  'day-water-adult':       { name: 'Adult (including water activities)',               isPerson: true  },
  'day-water-pensioner':   { name: 'Pensioner (including water activities)',           isPerson: true  },
  'day-no-water-infant':   { name: 'Children under 1 (excluding water activities)',   isPerson: true  },
  'day-no-water-toddler':  { name: 'Toddlers 1-2 (excluding water activities)',       isPerson: true  },
  'day-no-water-child':    { name: 'Children 3-17 (excluding water activities)',       isPerson: true  },
  'day-no-water-adult':    { name: 'Adult (excluding water activities)',               isPerson: true  },
  'day-no-water-pensioner':{ name: 'Pensioner (excluding water activities)',           isPerson: true  },
  'hut-covered':           { name: 'Covered Hut (Seating for 14-16)',                 isPerson: false },
  'hut-shaded':            { name: 'Shaded Table (Seating for 6)',                    isPerson: false },
};

// ---------------------------------------------------------------------------
// Client-facing package groups
// ---------------------------------------------------------------------------

export type PackageGroup = { category: string; items: Array<{ id: string; name: string; price: number }> };

export function buildPackageGroups(prices: PriceList = DEFAULT_PRICES): PackageGroup[] {
  const item = (id: string, stripSuffix: boolean) => ({
    id,
    name: stripSuffix ? BOOKABLE_ITEMS[id].name.replace(/ \(.*\)$/, '') : BOOKABLE_ITEMS[id].name,
    price: priceOf(prices, id),
  });
  return [
    {
      category: 'DAY VISITOR — INCLUDING WATER ACTIVITIES',
      items: ['day-water-infant', 'day-water-toddler', 'day-water-child', 'day-water-adult', 'day-water-pensioner'].map(id => item(id, true)),
    },
    {
      category: 'DAY VISITOR — EXCLUDING WATER ACTIVITIES',
      items: ['day-no-water-infant', 'day-no-water-toddler', 'day-no-water-child', 'day-no-water-adult', 'day-no-water-pensioner'].map(id => item(id, true)),
    },
    {
      category: 'DAY VISITOR HUTS',
      items: ['hut-covered', 'hut-shaded'].map(id => item(id, false)),
    },
  ];
}

/** Package groups at the default prices. */
export const PACKAGE_GROUPS = buildPackageGroups(DEFAULT_PRICES);

// ---------------------------------------------------------------------------
// Party pricing
// ---------------------------------------------------------------------------

export function partyChildRate(party: Pick<PartyDetails, 'option'>, prices: PriceList = DEFAULT_PRICES): number {
  return priceOf(prices, party.option === 'option-2' ? 'party-child-option-2' : 'party-child-option-1');
}

export function calculatePartyTotalFromPricing(party: PartyDetails, prices: PriceList = DEFAULT_PRICES): number {
  if (!party.enabled) return 0;
  const swimmingAdults = party.adultsWater.filter(Boolean).length;
  const nonSwimmingAdults = Math.max(0, party.adults - swimmingAdults);
  const swimmingChildren = party.additionalChildrenWater.filter(Boolean).length;
  const nonSwimmingChildren = Math.max(0, party.additionalChildren - swimmingChildren);
  return (
    party.children * partyChildRate(party, prices) +
    swimmingAdults * priceOf(prices, 'party-adult-swimming') +
    nonSwimmingAdults * priceOf(prices, 'party-adult-non-swimming') +
    swimmingChildren * priceOf(prices, 'party-child-swimming') +
    nonSwimmingChildren * priceOf(prices, 'party-child-non-swimming') +
    party.partyPacks * priceOf(prices, 'party-pack')
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
 * This is used on the server to verify the client total and to build the
 * booking items that are stored.
 */
export function calculateServerTotal(
  selections: Record<string, number>,
  party: PartyDetails | undefined,
  prices: PriceList = DEFAULT_PRICES,
): { lineItems: LineItem[]; total: number } {
  const lineItems: LineItem[] = [];
  const addLine = (itemId: string, name: string, quantity: number, pricePerUnit: number, isPerson: boolean, isParty: boolean) => {
    lineItems.push({ itemId, name, quantity, pricePerUnit, subtotal: pricePerUnit * quantity, isPerson, party: isParty });
  };

  // Package / hut items
  for (const [itemId, quantity] of Object.entries(selections)) {
    const qty = Number(quantity);
    if (qty <= 0) continue;
    const item = BOOKABLE_ITEMS[itemId];
    if (!item) continue; // unknown items are rejected by the caller
    addLine(itemId, item.name, qty, priceOf(prices, itemId), item.isPerson, false);
  }

  // Party items
  if (party?.enabled) {
    const adults = party.adults;
    const additionalChildren = party.additionalChildren;
    const swimmingAdults = party.adultsWater.filter(Boolean).slice(0, adults).length;
    const nonSwimmingAdults = adults - swimmingAdults;
    const swimmingChildren = party.additionalChildrenWater.filter(Boolean).slice(0, additionalChildren).length;
    const nonSwimmingChildren = additionalChildren - swimmingChildren;

    // Party children (the main party package)
    addLine('party-children', party.option === 'option-2' ? 'Kiddy Party Option 2 (hotdog included)' : 'Kiddy Party Option 1', party.children, partyChildRate(party, prices), false, true);
    if (swimmingAdults > 0) addLine('party-adult-swimming', 'Birthday party adult entrance (swimming)', swimmingAdults, priceOf(prices, 'party-adult-swimming'), true, true);
    if (nonSwimmingAdults > 0) addLine('party-adult-non-swimming', 'Birthday party adult entrance (non-swimming)', nonSwimmingAdults, priceOf(prices, 'party-adult-non-swimming'), true, true);
    if (swimmingChildren > 0) addLine('party-child-swimming', 'Additional birthday party child entrance (swimming)', swimmingChildren, priceOf(prices, 'party-child-swimming'), true, true);
    if (nonSwimmingChildren > 0) addLine('party-child-non-swimming', 'Additional birthday party child entrance (non-swimming)', nonSwimmingChildren, priceOf(prices, 'party-child-non-swimming'), true, true);
    if (party.partyPacks > 0) addLine('party-pack', 'Optional party pack', party.partyPacks, priceOf(prices, 'party-pack'), false, true);
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
