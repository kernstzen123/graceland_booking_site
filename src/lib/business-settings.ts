import 'server-only';
import { supabase } from '@/lib/supabase';
import { DEFAULT_DAILY_CAPACITY, DEFAULT_SUPPORT_EMAIL, DEFAULT_SUPPORT_PHONE } from '@/lib/business-details';

/**
 * Admin-editable business settings (the single business_settings row):
 * daily capacity and the support contact shown to customers and in emails.
 * Cached briefly because every email and the public contact box read them.
 */

export type BusinessSettings = { dailyCapacity: number; supportEmail: string; supportPhone: string; updatedAt: string | null };

const DEFAULTS: BusinessSettings = { dailyCapacity: DEFAULT_DAILY_CAPACITY, supportEmail: DEFAULT_SUPPORT_EMAIL, supportPhone: DEFAULT_SUPPORT_PHONE, updatedAt: null };
const CACHE_MS = 60_000;
let cached: { value: BusinessSettings; at: number } | null = null;

export async function getBusinessSettings(options: { fresh?: boolean } = {}): Promise<BusinessSettings> {
  if (!options.fresh && cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const { data, error } = await supabase.from('business_settings').select('daily_capacity,support_email,support_phone,updated_at').limit(1).maybeSingle();
  if (error) {
    // Columns added by 20260928_production_hardening.sql; fall back rather than break emails.
    console.error('Could not load business settings', error);
    return cached?.value || DEFAULTS;
  }
  const value: BusinessSettings = {
    dailyCapacity: Number(data?.daily_capacity) || DEFAULTS.dailyCapacity,
    supportEmail: data?.support_email || DEFAULTS.supportEmail,
    supportPhone: data?.support_phone || DEFAULTS.supportPhone,
    updatedAt: data?.updated_at || null,
  };
  cached = { value, at: Date.now() };
  return value;
}

export async function updateBusinessSettings(changes: Partial<Pick<BusinessSettings, 'dailyCapacity' | 'supportEmail' | 'supportPhone'>>, actorId: string) {
  const update: Record<string, unknown> = { updated_at: new Date().toISOString(), updated_by: actorId };
  if (changes.dailyCapacity !== undefined) update.daily_capacity = changes.dailyCapacity;
  if (changes.supportEmail !== undefined) update.support_email = changes.supportEmail;
  if (changes.supportPhone !== undefined) update.support_phone = changes.supportPhone;
  const { data: row, error: loadError } = await supabase.from('business_settings').select('id').limit(1).maybeSingle();
  if (loadError) throw loadError;
  const { error } = row
    ? await supabase.from('business_settings').update(update).eq('id', row.id)
    : await supabase.from('business_settings').insert({ business_name: 'Graceland Venues', ...update });
  if (error) throw error;
  cached = null;
  return getBusinessSettings({ fresh: true });
}
