import { supabase } from '@/lib/supabase';
import { DEFAULT_PRICES, mergePrices, type PriceList } from '@/lib/pricing';

// The migration has not been applied yet: PostgREST reports PGRST205, Postgres 42P01.
const MISSING_TABLE = new Set(['PGRST205', '42P01']);

export type StoredPrice = { key: string; price: number; updated_at: string; updated_by: string | null };

/** Stored price overrides. Returns [] until the migration has been applied. */
export async function getStoredPrices(): Promise<StoredPrice[]> {
  const { data, error } = await supabase.from('price_settings').select('key,price,updated_at,updated_by');
  if (error) {
    if (MISSING_TABLE.has(error.code)) {
      console.error('price_settings table is missing; charging default prices. Apply supabase/migrations/20260924_admin_prices_and_closures.sql.');
      return [];
    }
    throw error;
  }
  return (data || []).map(row => ({ ...row, price: Number(row.price) }));
}

/** The prices currently charged: the code defaults with admin overrides applied. */
export async function getCurrentPrices(): Promise<PriceList> {
  const stored = await getStoredPrices();
  return stored.length ? mergePrices(stored) : { ...DEFAULT_PRICES };
}
