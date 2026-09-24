import { calculatePartyTotalFromPricing, DEFAULT_PRICES, type PriceList } from './pricing';

export type PartyOption = 'option-1' | 'option-2';

export type PartyDetails = {
  enabled: boolean;
  option: PartyOption;
  children: number;
  adults: number;
  adultsWater: boolean[];
  additionalChildren: number;
  additionalChildrenWater: boolean[];
  partyPacks: number;
  slot: string;
};

export const PARTY_SLOTS = {
  weekday: ['14:30–16:30'],
  saturday: ['09:30–11:30', '12:00–14:00', '14:30–16:30'],
  sunday: ['10:30–12:30', '13:00–15:00'],
} as const;

const toUtcDate = (value: string) => {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
};

const formatDate = (date: Date) => date.toISOString().slice(0, 10);

function easterSunday(year: number) {
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
  return new Date(Date.UTC(year, month - 1, day));
}

function southAfricanPublicHolidays(year: number) {
  const holidays = new Set<string>();
  const add = (month: number, day: number) => holidays.add(formatDate(new Date(Date.UTC(year, month - 1, day))));
  add(1, 1); add(3, 21); add(4, 27); add(5, 1); add(6, 16); add(8, 9); add(9, 24); add(12, 16); add(12, 25); add(12, 26);
  const easter = easterSunday(year);
  for (const offset of [-2, 1]) {
    const date = new Date(easter);
    date.setUTCDate(date.getUTCDate() + offset);
    holidays.add(formatDate(date));
  }
  // A public holiday falling on Sunday makes the following Monday a holiday.
  for (const holiday of [...holidays]) {
    const date = toUtcDate(holiday);
    if (date.getUTCDay() === 0) {
      date.setUTCDate(date.getUTCDate() + 1);
      holidays.add(formatDate(date));
    }
  }
  return holidays;
}

export function getPartySlots(dateValue: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) return [];
  const date = toUtcDate(dateValue);
  const day = date.getUTCDay();
  const month = date.getUTCMonth() + 1;
  const dayOfMonth = date.getUTCDate();
  const isDecemberSchoolHolidayMonday = month === 12 && day === 1;
  const isBlackout = (month === 12 && dayOfMonth >= 25) || (month === 1 && dayOfMonth <= 7);
  const isPublicHoliday = southAfricanPublicHolidays(date.getUTCFullYear()).has(dateValue);
  if (isBlackout) return [];
  // Sunday parties are closed from May through the end of September.
  if (day === 0 && (month >= 5 && month <= 9)) return [];
  if (isPublicHoliday) return month >= 5 && month <= 9 ? [] : [...PARTY_SLOTS.sunday];
  if (day === 1 && !isDecemberSchoolHolidayMonday) return [];
  if (day >= 2 && day <= 5) return [...PARTY_SLOTS.weekday];
  if (day === 6) return [...PARTY_SLOTS.saturday];
  if (day === 0 || southAfricanPublicHolidays(date.getUTCFullYear()).has(dateValue)) return [...PARTY_SLOTS.sunday];
  return [];
}

export function calculatePartyTotal(party: PartyDetails, prices: PriceList = DEFAULT_PRICES) {
  return calculatePartyTotalFromPricing(party, prices);
}

export function nextPartyDate(fromDate: string) {
  const date = toUtcDate(fromDate);
  for (let i = 1; i <= 370; i++) {
    date.setUTCDate(date.getUTCDate() + 1);
    if (getPartySlots(formatDate(date)).length) return formatDate(date);
  }
  return null;
}
