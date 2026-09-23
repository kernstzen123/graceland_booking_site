// ---------------------------------------------------------------------------
// verify-opening-rules.ts — Automated tests for Graceland opening rules
//
// Run with: npx tsx scripts/verify-opening-rules.ts
// Exits non-zero on any failure.
// ---------------------------------------------------------------------------

import {
  getOpeningStatus,
  isEasterRelated,
  easterSunday,
  validateVisitDate,
  johannesburgToday,
  SCHOOL_HOLIDAYS,
  PUBLIC_HOLIDAYS,
} from '../src/lib/opening-rules';

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.error(`  ❌ FAIL: ${label}`);
  }
}

function assertStatus(label: string, dateStr: string, expectOpen: boolean, expectHours?: { open: string; close: string }) {
  const status = getOpeningStatus(dateStr);
  const openMatch = status.open === expectOpen;
  const hoursMatch = !expectHours || (status.hours?.open === expectHours.open && status.hours?.close === expectHours.close);
  assert(`${label} — ${dateStr} → ${expectOpen ? 'OPEN' : 'CLOSED'}${expectHours ? ` (${expectHours.open}–${expectHours.close})` : ''}${!openMatch ? ` [GOT: ${status.open ? 'OPEN' : 'CLOSED'}]` : ''}${!hoursMatch ? ` [GOT hours: ${status.hours?.open}–${status.hours?.close}]` : ''} (reason: ${status.reason})`, openMatch && hoursMatch);
}

function assertValidateThrows(label: string, dateStr: string, expectedSubstring: string) {
  try {
    validateVisitDate(dateStr);
    assert(`${label} — expected throw but didn't`, false);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    assert(`${label} — threw: "${msg}"`, msg.includes(expectedSubstring));
  }
}

// ── Easter algorithm verification ──────────────────────────────────────────

console.log('\n=== Easter Algorithm ===');

// 2026: Easter Sunday = 5 April
const e2026 = easterSunday(2026);
assert('Easter 2026 = 5 April', e2026.month === 4 && e2026.day === 5);

// 2027: Easter Sunday = 28 March
const e2027 = easterSunday(2027);
assert('Easter 2027 = 28 March', e2027.month === 3 && e2027.day === 28);

// Verify Easter-related days 2026
assert('Good Friday 2026 (3 Apr)', isEasterRelated('2026-04-03'));
assert('Easter Saturday 2026 (4 Apr)', isEasterRelated('2026-04-04'));
assert('Easter Sunday 2026 (5 Apr)', isEasterRelated('2026-04-05'));
assert('Easter Monday 2026 (6 Apr)', isEasterRelated('2026-04-06'));
assert('Day before Good Friday 2026 (2 Apr) — NOT Easter', !isEasterRelated('2026-04-02'));
assert('Day after Easter Monday 2026 (7 Apr) — NOT Easter', !isEasterRelated('2026-04-07'));

// Verify Easter-related days 2027
assert('Good Friday 2027 (26 Mar)', isEasterRelated('2027-03-26'));
assert('Easter Saturday 2027 (27 Mar)', isEasterRelated('2027-03-27'));
assert('Easter Sunday 2027 (28 Mar)', isEasterRelated('2027-03-28'));
assert('Easter Monday 2027 (29 Mar)', isEasterRelated('2027-03-29'));

// ── Tuesday–Saturday in term (open) ────────────────────────────────────────

console.log('\n=== Term Time: Weekdays (Tue–Sat open, Mon closed) ===');

// 2026-10-06 is a Tuesday in term (after spring holiday ends 2026-10-05)
assertStatus('Term Tuesday Oct 2026', '2026-10-06', true, { open: '10:00', close: '16:00' });

// 2026-10-07 is a Wednesday
assertStatus('Term Wednesday Oct 2026', '2026-10-07', true, { open: '10:00', close: '16:00' });

// 2026-10-10 is a Saturday
assertStatus('Term Saturday Oct 2026', '2026-10-10', true, { open: '09:00', close: '17:00' });

// 2026-10-12 is a Monday — should be closed
assertStatus('Term Monday Oct 2026', '2026-10-12', false);

// ── School holiday Monday (open, 10:00–16:00) ──────────────────────────────

console.log('\n=== School Holiday: All days open (Tue–Fri hours) ===');

// 2026-03-30 is a Monday during 2026 Autumn break (2026-03-28 to 2026-04-07)
assertStatus('School holiday Monday (2026 Autumn)', '2026-03-30', true, { open: '10:00', close: '16:00' });

// 2026-09-27 is a Sunday during 2026 Spring break (2026-09-24 to 2026-10-05) — open!
assertStatus('School holiday Sunday (2026 Spring)', '2026-09-27', true, { open: '10:00', close: '16:00' });

// 2026-09-28 is a Monday during Spring break — open
assertStatus('School holiday Monday (2026 Spring)', '2026-09-28', true, { open: '10:00', close: '16:00' });

// ── Sunday in November 2026 (open, Oct–Apr) ────────────────────────────────

console.log('\n=== Sundays ===');

// 2026-11-01 is a Sunday
assertStatus('Sunday Nov 2026 (in Oct–Apr → open)', '2026-11-01', true, { open: '10:00', close: '17:00' });

// ── Sunday in September 2026 during TERM (closed) ─────────────────────────

// 2026-09-20 is a Sunday in September, outside school holiday (spring starts 2026-09-24)
assertStatus('Sunday Sep 2026 (term, outside Oct–Apr → closed)', '2026-09-20', false);

// ── Sunday in September 2026 during SCHOOL HOLIDAY (open) ──────────────────

// 2026-09-27 is a Sunday during spring school holiday → school holiday rule fires first → open
assertStatus('Sunday Sep 2026 (school holiday → open)', '2026-09-27', true, { open: '10:00', close: '16:00' });

// ── May–August (closed for everything) ─────────────────────────────────────

console.log('\n=== May–August Blanket Closure ===');

// Various dates in May–Aug, including school holidays and public holidays
assertStatus('1 May 2026 (Workers\' Day, but May–Aug closure)', '2026-05-01', false);
assertStatus('16 Jun 2026 (Youth Day, but May–Aug)', '2026-06-16', false);
assertStatus('1 Jul 2026 (school holiday, but May–Aug)', '2026-07-01', false);
assertStatus('9 Aug 2026 (Women\'s Day, but May–Aug)', '2026-08-09', false);
assertStatus('31 Aug 2026 (last day of closure)', '2026-08-31', false);

assertStatus('1 May 2027 (Workers\' Day, May–Aug)', '2027-05-01', false);
assertStatus('16 Jun 2027 (Youth Day, May–Aug)', '2027-06-16', false);
assertStatus('1 Jul 2027 (school holiday, May–Aug)', '2027-07-01', false);
assertStatus('9 Aug 2027 (Women\'s Day, May–Aug)', '2027-08-09', false);
assertStatus('31 Aug 2027 (last day)', '2027-08-31', false);

// ── 30 April vs 1 May boundary ─────────────────────────────────────────────

console.log('\n=== 30 April vs 1 May Boundary ===');

// 2026-04-30 is a Thursday → open (term time or verify)
assertStatus('30 Apr 2026 (Thu, open)', '2026-04-30', true, { open: '10:00', close: '16:00' });
assertStatus('1 May 2026 (Fri, CLOSED — May–Aug)', '2026-05-01', false);

// 2027-04-30 is a Friday → open
assertStatus('30 Apr 2027 (Fri, open)', '2027-04-30', true, { open: '10:00', close: '16:00' });
assertStatus('1 May 2027 (Sat, CLOSED — May–Aug)', '2027-05-01', false);

// ── Christmas Day (closed) ─────────────────────────────────────────────────

console.log('\n=== Christmas Day ===');

assertStatus('25 Dec 2026 (Christmas)', '2026-12-25', false);
assertStatus('25 Dec 2027 (Christmas)', '2027-12-25', false);
// Boxing Day should be OPEN (school holiday)
assertStatus('26 Dec 2026 (Boxing Day, school holiday → open)', '2026-12-26', true, { open: '10:00', close: '16:00' });

// ── Easter Weekend (closed) ────────────────────────────────────────────────

console.log('\n=== Easter Weekend ===');

// 2026: Good Friday = 3 Apr, Easter Sat = 4 Apr, Easter Sun = 5 Apr, Easter Mon = 6 Apr
assertStatus('Good Friday 2026', '2026-04-03', false);
assertStatus('Easter Saturday 2026', '2026-04-04', false);
assertStatus('Easter Sunday 2026', '2026-04-05', false);
assertStatus('Easter Monday 2026', '2026-04-06', false);

// 2027: Good Friday = 26 Mar, Easter Sat = 27 Mar, Easter Sun = 28 Mar, Easter Mon = 29 Mar
assertStatus('Good Friday 2027', '2027-03-26', false);
assertStatus('Easter Saturday 2027', '2027-03-27', false);
assertStatus('Easter Sunday 2027', '2027-03-28', false);
assertStatus('Easter Monday 2027', '2027-03-29', false);

// ── Heritage Day 2026 (Thu Sep 24 — open; first day of spring holiday) ─────

console.log('\n=== Heritage Day & Special Cases ===');

// 2026-09-24 is a Thursday AND the first day of the spring school holiday
// Both the school-holiday rule and the Tue–Fri rule agree it's open
assertStatus('Heritage Day 2026 (Thu, school holiday start → open)', '2026-09-24', true, { open: '10:00', close: '16:00' });

// ── 4 November 2026 (election day, Wednesday → open) ───────────────────────

// 2026-11-04 is a Wednesday — the election public holiday should NOT close it
// since Tue–Fri in term time is open anyway
assertStatus('Election Day 4 Nov 2026 (Wed, term → open)', '2026-11-04', true, { open: '10:00', close: '16:00' });

// ── Monday public holiday in November (open — Oct–Apr range) ────────────────

console.log('\n=== Public Holiday Monday / Sunday Edge Cases ===');

// There's no actual Monday public holiday in Nov in the data. Let's check a
// Monday public holiday in the Oct–Apr range: 2027-03-22 is Human Rights Day
// (observed) — it's a Monday. This falls in the 2027 Autumn school holiday
// (2027-03-20 to 2027-04-05), so rule 4 (school holiday) fires first.
// But for the rule-5 path, check: 2026-04-27 Freedom Day is a Monday.
// 2026-04-27 is inside the 2026 Autumn school holiday? Let's check:
// 2026 Autumn: 2026-03-28 to 2026-04-07. 2026-04-27 is OUTSIDE that range.
// So it falls into rule 5 → Monday + public holiday + April (Oct–Apr) → OPEN
assertStatus('Freedom Day 2026 (Mon Apr 27, pub hol in Oct–Apr → open)', '2026-04-27', true, { open: '10:00', close: '17:00' });

// ── Monday public holiday in September (closed — outside Oct–Apr) ───────────

// 2026-09-24 Heritage Day falls on a Thursday, not helpful.
// For a Monday public holiday outside Oct–Apr: we need to test the rule path.
// 2026-08-10 National Women's Day (observed) is a Monday... but it's in May–Aug → closed by rule 3.
// There's no Monday pub holiday in Sep in the data. Let's verify the rule path
// by checking a synthetic scenario: what about a date in Sep that's a Monday
// and happens to be a public holiday? We can't manufacture public holidays but
// we can at least verify that non-school-holiday Sep Mondays are closed:
assertStatus('Monday Sep 21 2026 (term, Monday → closed)', '2026-09-21', false);

// ── validateVisitDate ──────────────────────────────────────────────────────

console.log('\n=== validateVisitDate (format, past, closed) ===');

// Invalid date string
assertValidateThrows('Invalid format', 'not-a-date', 'Invalid visit date');
assertValidateThrows('Invalid format (partial)', '2026-13-01', 'Invalid visit date');
assertValidateThrows('Invalid format (Feb 30)', '2026-02-30', 'Invalid visit date');

// Past date (use a date we know is in the past)
assertValidateThrows('Past date', '2020-01-15', 'already passed');

// Closed date
assertValidateThrows('Closed date (Christmas)', '2026-12-25', 'closed');
assertValidateThrows('Closed date (May)', '2027-05-15', 'closed');
assertValidateThrows('Closed date (Monday in term)', '2026-10-12', 'closed');

// ── johannesburgToday ──────────────────────────────────────────────────────

console.log('\n=== johannesburgToday ===');

const today = johannesburgToday();
assert(`johannesburgToday() returns valid YYYY-MM-DD: ${today}`, /^\d{4}-\d{2}-\d{2}$/.test(today));

// ── Data integrity ─────────────────────────────────────────────────────────

console.log('\n=== Data Integrity ===');

assert(`SCHOOL_HOLIDAYS has ${SCHOOL_HOLIDAYS.length} entries`, SCHOOL_HOLIDAYS.length === 8);
assert(`PUBLIC_HOLIDAYS has ${PUBLIC_HOLIDAYS.length} entries`, PUBLIC_HOLIDAYS.length === 28);

// Verify all school holiday ranges have valid dates
for (const range of SCHOOL_HOLIDAYS) {
  assert(`School holiday ${range.label}: from <= to`, range.from <= range.to);
}

// ── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${'='.repeat(60)}`);
console.log(`RESULTS: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log('='.repeat(60));

if (failed > 0) {
  console.error('\n💥 SOME TESTS FAILED');
  process.exit(1);
} else {
  console.log('\n✅ ALL TESTS PASSED');
  process.exit(0);
}
