/**
 * Verify that server-side pricing (calculateServerTotal) matches the client-side
 * calculation (PACKAGES + calculatePartyTotal) for at least 10 sample bookings.
 *
 * Run with: npx tsx scripts/verify-pricing.ts
 */

import { calculateServerTotal, PACKAGE_GROUPS } from '../src/lib/pricing';
import { calculatePartyTotal, PartyDetails } from '../src/lib/parties';

// Client-side total calculation (same logic as page.tsx calculateTotal)
function clientTotal(selections: Record<string, number>, party: PartyDetails): number {
  let total = 0;
  PACKAGE_GROUPS.forEach(group => {
    group.items.forEach(item => {
      total += (selections[item.id] || 0) * item.price;
    });
  });
  return total + calculatePartyTotal(party);
}

const noParty: PartyDetails = {
  enabled: false, option: 'option-1', children: 10, adults: 0,
  adultsWater: [], additionalChildren: 0, additionalChildrenWater: [],
  partyPacks: 0, slot: '',
};

type TestCase = {
  name: string;
  selections: Record<string, number>;
  party: PartyDetails;
};

const testCases: TestCase[] = [
  // 1. Simple day-water booking
  {
    name: '1 adult + 2 children (water)',
    selections: { 'day-water-adult': 1, 'day-water-child': 2 },
    party: noParty,
  },
  // 2. No-water family
  {
    name: '2 adults + 3 children (no water)',
    selections: { 'day-no-water-adult': 2, 'day-no-water-child': 3 },
    party: noParty,
  },
  // 3. Hut booking
  {
    name: '6 adults (water) + covered hut',
    selections: { 'day-water-adult': 6, 'hut-covered': 1 },
    party: noParty,
  },
  // 4. Shaded table
  {
    name: '2 adults + shaded table',
    selections: { 'day-water-adult': 2, 'hut-shaded': 1 },
    party: noParty,
  },
  // 5. Mixed water/no-water
  {
    name: 'Mixed water/no-water adults + children',
    selections: { 'day-water-adult': 1, 'day-no-water-adult': 1, 'day-water-child': 2, 'day-no-water-child': 1 },
    party: noParty,
  },
  // 6. Party option 1, all swimming adults
  {
    name: 'Party option 1 (10 children, 3 swimming adults)',
    selections: {},
    party: {
      enabled: true, option: 'option-1', children: 10, adults: 3,
      adultsWater: [true, true, true], additionalChildren: 0,
      additionalChildrenWater: [], partyPacks: 0, slot: '09:30–11:30',
    },
  },
  // 7. Party option 2, mixed adults
  {
    name: 'Party option 2 (12 children, 2 swimming + 1 non-swimming adult)',
    selections: {},
    party: {
      enabled: true, option: 'option-2', children: 12, adults: 3,
      adultsWater: [true, true, false], additionalChildren: 0,
      additionalChildrenWater: [], partyPacks: 5, slot: '12:00–14:00',
    },
  },
  // 8. Party with additional swimming children
  {
    name: 'Party option 1 with 5 additional swimming children',
    selections: {},
    party: {
      enabled: true, option: 'option-1', children: 10, adults: 2,
      adultsWater: [false, false], additionalChildren: 5,
      additionalChildrenWater: [true, true, true, true, true],
      partyPacks: 10, slot: '14:30–16:30',
    },
  },
  // 9. Party with mixed additional children (swimming + non-swimming)
  {
    name: 'Party option 2 with mixed additional children',
    selections: {},
    party: {
      enabled: true, option: 'option-2', children: 15, adults: 4,
      adultsWater: [true, false, true, false], additionalChildren: 6,
      additionalChildrenWater: [true, false, true, false, true, false],
      partyPacks: 3, slot: '09:30–11:30',
    },
  },
  // 10. Pensioners + infants + toddlers
  {
    name: 'Pensioners + infants + toddlers (water)',
    selections: {
      'day-water-pensioner': 2, 'day-water-infant': 1,
      'day-water-toddler': 1, 'day-water-child': 1,
    },
    party: noParty,
  },
  // 11. Everything combined: packages + party + huts
  {
    name: 'Combined: day visitors + party + hut',
    selections: { 'day-water-adult': 2, 'day-no-water-child': 1, 'hut-covered': 1 },
    party: {
      enabled: true, option: 'option-1', children: 10, adults: 1,
      adultsWater: [true], additionalChildren: 2,
      additionalChildrenWater: [true, false], partyPacks: 0, slot: '14:30–16:30',
    },
  },
  // 12. Large booking
  {
    name: 'Large group: 20 adults + 15 children (water) + 2 huts + 2 tables',
    selections: {
      'day-water-adult': 20, 'day-water-child': 15,
      'hut-covered': 2, 'hut-shaded': 2,
    },
    party: noParty,
  },
  // 13. Free items only (infants no-water) — server should catch this as <= 0
  {
    name: 'Free items only (2 no-water infants + 1 adult)',
    selections: { 'day-no-water-infant': 2, 'day-no-water-adult': 1 },
    party: noParty,
  },
];

let failures = 0;
console.log('=== Pricing Verification ===\n');

for (const tc of testCases) {
  const server = calculateServerTotal(tc.selections, tc.party.enabled ? tc.party : undefined);
  const client = clientTotal(tc.selections, tc.party);
  const match = Math.abs(server.total - client) < 0.01;
  const status = match ? '✓' : '✗';
  console.log(`${status} ${tc.name}`);
  console.log(`  Server: R ${server.total.toFixed(2)}  |  Client: R ${client.toFixed(2)}`);
  if (!match) {
    console.log(`  *** MISMATCH ***`);
    failures++;
  }
}

console.log(`\n=== ${testCases.length} tests, ${failures} failures ===`);
if (failures > 0) {
  process.exit(1);
}
