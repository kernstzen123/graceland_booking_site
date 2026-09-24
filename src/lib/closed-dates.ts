import { supabase } from '@/lib/supabase';
import { getOpeningStatus, validateVisitDate, type OpeningStatus } from '@/lib/opening-rules';

// The migration has not been applied yet: PostgREST reports PGRST205, Postgres 42P01.
const MISSING_TABLE = new Set(['PGRST205', '42P01']);

export const CLOSED_BY_ADMIN_MESSAGE = 'Graceland is closed on the selected date. Please choose another date.';

/** Admin-closed dates between from and to (inclusive), mapped to their reason. */
export async function getClosedDates(from: string, to: string): Promise<Map<string, string>> {
  const { data, error } = await supabase.from('closed_dates').select('date,reason').gte('date', from).lte('date', to);
  if (error) {
    if (MISSING_TABLE.has(error.code)) return new Map();
    throw error;
  }
  return new Map((data || []).map(row => [String(row.date), String(row.reason || '')]));
}

export async function isClosedByAdmin(date: string): Promise<boolean> {
  return (await getClosedDates(date, date)).has(date);
}

/** Opening status that also honours dates closed from the admin panel. */
export function applyClosure(date: string, closed: Map<string, string>): OpeningStatus {
  if (closed.has(date)) return { open: false, reason: closed.get(date) || 'Closed' };
  return getOpeningStatus(date);
}

/**
 * validateVisitDate plus the admin closures. Throws customer-safe messages.
 * Use this anywhere a customer can pick or book a date.
 */
export async function validateBookableDate(date: string): Promise<void> {
  validateVisitDate(date);
  if (await isClosedByAdmin(date)) throw new Error(CLOSED_BY_ADMIN_MESSAGE);
}
