// ---------------------------------------------------------------------------
// Graceland Venues — Opening Rules (hardcoded, no database)
//
// This file is the SINGLE SOURCE OF TRUTH for day-visitor opening/closing
// logic. It contains no database calls and no imports from Supabase.
//
// MAINTENANCE: This system has no admin UI. To add 2028+ school holidays or
// public holidays, a developer must edit the SCHOOL_HOLIDAYS and
// PUBLIC_HOLIDAYS arrays directly in this file and redeploy. See the arrays
// below for the exact format.
// ---------------------------------------------------------------------------

// ── Timezone helper ────────────────────────────────────────────────────────

/** Returns today's date as YYYY-MM-DD in the Africa/Johannesburg timezone. */
export function johannesburgToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg' }).format(new Date());
}

// ── School holidays ────────────────────────────────────────────────────────
// Confirmed against the Government Gazette (school calendar: Notices 5901/5902
// of 25 Feb 2025; public holidays: Public Holidays Act 36 of 1994 plus the
// gazetted 2026 election-day holiday). Dates beyond 2027 are not yet included
// and must be added manually — there is no admin UI for this; see
// src/lib/opening-rules.ts to update.

export type SchoolHolidayRange = { label: string; from: string; to: string };

export const SCHOOL_HOLIDAYS: SchoolHolidayRange[] = [
  { label: '2026 Autumn',  from: '2026-03-28', to: '2026-04-07' },
  { label: '2026 Winter',  from: '2026-06-27', to: '2026-07-20' }, // fully inside the May–Aug closure — included for correctness/documentation
  { label: '2026 Spring',  from: '2026-09-24', to: '2026-10-05' },
  { label: '2026/27 Summer', from: '2026-12-10', to: '2027-01-12' },
  { label: '2027 Autumn',  from: '2027-03-20', to: '2027-04-05' },
  { label: '2027 Winter',  from: '2027-06-26', to: '2027-07-19' }, // fully inside the May–Aug closure — included for correctness/documentation
  { label: '2027 Spring',  from: '2027-09-23', to: '2027-10-04' },
  // TEMPORARY: 2028 Term 1 start date not yet gazetted by the Department of
  // Basic Education. Verify and update this end date once published — check
  // https://www.gov.za or the DBE gazette.
  { label: '2027/28 Summer', from: '2027-12-13', to: '2028-02-29' },
];

// ── Public holidays ────────────────────────────────────────────────────────
// Confirmed against the Government Gazette (school calendar: Notices 5901/5902
// of 25 Feb 2025; public holidays: Public Holidays Act 36 of 1994 plus the
// gazetted 2026 election-day holiday). Dates beyond 2027 are not yet included
// and must be added manually — there is no admin UI for this; see
// src/lib/opening-rules.ts to update.

export type PublicHoliday = { date: string; name: string };

export const PUBLIC_HOLIDAYS: PublicHoliday[] = [
  { date: '2026-01-01', name: 'New Year\'s Day' },
  { date: '2026-03-21', name: 'Human Rights Day' },
  { date: '2026-04-03', name: 'Good Friday' },
  { date: '2026-04-06', name: 'Family Day' },
  { date: '2026-04-27', name: 'Freedom Day' },
  { date: '2026-05-01', name: 'Workers\' Day' },
  { date: '2026-06-16', name: 'Youth Day' },
  { date: '2026-08-09', name: 'National Women\'s Day' },
  { date: '2026-08-10', name: 'National Women\'s Day (observed)' },
  { date: '2026-09-24', name: 'Heritage Day' },
  { date: '2026-11-04', name: 'Local Government Elections' },
  { date: '2026-12-16', name: 'Day of Reconciliation' },
  { date: '2026-12-25', name: 'Christmas Day' },
  { date: '2026-12-26', name: 'Day of Goodwill' },
  { date: '2027-01-01', name: 'New Year\'s Day' },
  { date: '2027-03-21', name: 'Human Rights Day' },
  { date: '2027-03-22', name: 'Human Rights Day (observed)' },
  { date: '2027-03-26', name: 'Good Friday' },
  { date: '2027-03-29', name: 'Family Day' },
  { date: '2027-04-27', name: 'Freedom Day' },
  { date: '2027-05-01', name: 'Workers\' Day' },
  { date: '2027-06-16', name: 'Youth Day' },
  { date: '2027-08-09', name: 'National Women\'s Day' },
  { date: '2027-09-24', name: 'Heritage Day' },
  { date: '2027-12-16', name: 'Day of Reconciliation' },
  { date: '2027-12-25', name: 'Christmas Day' },
  { date: '2027-12-26', name: 'Day of Goodwill' },
  { date: '2027-12-27', name: 'Day of Goodwill (observed)' },
];

const publicHolidaySet = new Set(PUBLIC_HOLIDAYS.map(h => h.date));

// ── Easter calculation (Meeus/Jones/Butcher algorithm) ─────────────────────

/**
 * Compute Easter Sunday for a given year using the Meeus/Jones/Butcher
 * algorithm. Returns { month, day } as 1-indexed values.
 */
export function easterSunday(year: number): { month: number; day: number } {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

/**
 * Returns true if dateStr (YYYY-MM-DD) falls on Good Friday, Easter Saturday,
 * Easter Sunday, or Easter Monday.
 */
export function isEasterRelated(dateStr: string): boolean {
  const [year, month, day] = dateStr.split('-').map(Number);
  const easter = easterSunday(year);
  // Easter Sunday as a day-of-year offset for simple ±2/±1/0/+1 comparison
  const easterDayOfYear = dayOfYear(year, easter.month, easter.day);
  const dateDayOfYear = dayOfYear(year, month, day);
  const diff = dateDayOfYear - easterDayOfYear;
  // Good Friday = -2, Saturday = -1, Sunday = 0, Monday = +1
  return diff >= -2 && diff <= 1;
}

/** Day-of-year for a given date (1-indexed). */
function dayOfYear(year: number, month: number, day: number): number {
  const daysInMonths = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0) daysInMonths[2] = 29;
  let total = 0;
  for (let m = 1; m < month; m++) total += daysInMonths[m];
  return total + day;
}

// ── Parse helper ───────────────────────────────────────────────────────────

/** Parse YYYY-MM-DD as a plain calendar date with no timezone shifting. */
function parseDateStr(dateStr: string): { year: number; month: number; day: number; dayOfWeek: number } {
  const [year, month, day] = dateStr.split('-').map(Number);
  // Use UTC to get the correct day-of-week for the calendar date
  const d = new Date(Date.UTC(year, month - 1, day));
  return { year, month, day, dayOfWeek: d.getUTCDay() }; // 0=Sun, 1=Mon, ..., 6=Sat
}

// ── School holiday check ───────────────────────────────────────────────────

function isSchoolHoliday(dateStr: string): boolean {
  return SCHOOL_HOLIDAYS.some(range => dateStr >= range.from && dateStr <= range.to);
}

// ── Opening status ─────────────────────────────────────────────────────────

export type OpeningHours = { open: string; close: string; poolsClose: string };
export type OpeningStatus = { open: boolean; reason: string; hours?: OpeningHours };

const TUE_FRI_HOURS: OpeningHours = { open: '10:00', close: '16:00', poolsClose: '15:45' };
const SATURDAY_HOURS: OpeningHours = { open: '09:00', close: '17:00', poolsClose: '16:45' };
const SUNDAY_HOURS: OpeningHours = { open: '10:00', close: '17:00', poolsClose: '16:45' };

/** Month is in the October–April inclusive range. */
function isOctApr(month: number): boolean {
  return month >= 10 || month <= 4;
}

/**
 * Determine the opening status for a given date string (YYYY-MM-DD).
 *
 * Rules are evaluated in the following order — first match wins:
 *   1. Christmas Day (25 Dec) → closed
 *   2. Easter weekend (Good Friday – Easter Monday) → closed
 *   3. 1 May – 31 Aug → closed (no exceptions)
 *   4. School holiday (outside May–Aug) → open daily, Tue–Fri hours
 *   5. Term time: Tue–Fri open, Sat open (different hours), Sun Oct–Apr,
 *      public holiday on Sun/Mon Oct–Apr, otherwise Monday closed
 *   6. Default → closed (Monday or out-of-season Sunday)
 */
export function getOpeningStatus(dateStr: string): OpeningStatus {
  const { month, day, dayOfWeek } = parseDateStr(dateStr);

  // Rule 1: Christmas Day
  if (month === 12 && day === 25) {
    return { open: false, reason: 'Closed for Christmas Day' };
  }

  // Rule 2: Easter weekend (Good Friday through Easter Monday)
  if (isEasterRelated(dateStr)) {
    return { open: false, reason: 'Closed for Easter weekend' };
  }

  // Rule 3: May–August blanket closure
  if (month >= 5 && month <= 8) {
    return { open: false, reason: 'Closed for winter season (May–August)' };
  }

  // Rule 4: School holiday (outside May–Aug, since rule 3 already caught those)
  if (isSchoolHoliday(dateStr)) {
    return { open: true, reason: 'School holiday — open daily', hours: TUE_FRI_HOURS };
  }

  // Rule 5: Term time
  const isPublicHol = publicHolidaySet.has(dateStr);

  // Tuesday–Friday (dayOfWeek 2–5)
  if (dayOfWeek >= 2 && dayOfWeek <= 5) {
    return { open: true, reason: isPublicHol ? 'Public holiday (open, weekday hours)' : 'Open (Tuesday–Friday)', hours: TUE_FRI_HOURS };
  }

  // Saturday (dayOfWeek 6)
  if (dayOfWeek === 6) {
    return { open: true, reason: isPublicHol ? 'Public holiday (open, Saturday hours)' : 'Open (Saturday)', hours: SATURDAY_HOURS };
  }

  // Sunday (dayOfWeek 0)
  if (dayOfWeek === 0) {
    if (isPublicHol && isOctApr(month)) {
      return { open: true, reason: 'Public holiday Sunday (October–April)', hours: SUNDAY_HOURS };
    }
    if (!isPublicHol && isOctApr(month)) {
      return { open: true, reason: 'Open (Sunday, October–April)', hours: SUNDAY_HOURS };
    }
    return { open: false, reason: 'Closed (Sunday outside October–April)' };
  }

  // Monday (dayOfWeek 1)
  if (dayOfWeek === 1) {
    if (isPublicHol && isOctApr(month)) {
      return { open: true, reason: 'Public holiday Monday (October–April)', hours: SUNDAY_HOURS };
    }
    return { open: false, reason: 'Closed (Monday)' };
  }

  // Fallback (should be unreachable)
  return { open: false, reason: 'Closed' };
}

// ── Visit date validation ──────────────────────────────────────────────────

/**
 * Validate a visit date string for booking. Throws with customer-safe messages.
 *
 * Checks:
 *   1. Valid YYYY-MM-DD format
 *   2. Not a past date (compared using Africa/Johannesburg timezone)
 *   3. Not a closed date per opening rules
 */
export function validateVisitDate(dateStr: string): void {
  // Format check
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new Error('Invalid visit date');
  }
  // Confirm the date is a real calendar date (e.g., reject 2026-02-30)
  const [y, m, d] = dateStr.split('-').map(Number);
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) {
    throw new Error('Invalid visit date');
  }

  // Past date check (Africa/Johannesburg)
  const today = johannesburgToday();
  if (dateStr < today) {
    throw new Error('The selected visit date has already passed. Please choose a future date.');
  }

  // Opening status check
  const status = getOpeningStatus(dateStr);
  if (!status.open) {
    throw new Error('Graceland is closed on the selected date. Please choose another date.');
  }
}
