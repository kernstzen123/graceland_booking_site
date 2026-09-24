import { NextResponse } from 'next/server';
import { AdminAuthError, requireAdmin, writeAudit } from '@/lib/admin-auth';
import { supabase } from '@/lib/supabase';
import { DEFAULT_PRICES, MAX_PRICE, mergePrices, PRICE_DEFINITIONS } from '@/lib/pricing';
import { getStoredPrices } from '@/lib/price-store';

export async function GET(request: Request) {
  try {
    await requireAdmin(request, ['ADMIN', 'MANAGER']);
    const stored = await getStoredPrices();
    const current = mergePrices(stored);
    const storedByKey = new Map(stored.map(row => [row.key, row]));
    const prices = PRICE_DEFINITIONS.map(def => ({
      ...def,
      price: current[def.key],
      updatedAt: storedByKey.get(def.key)?.updated_at || null,
    }));
    return NextResponse.json({ success: true, prices });
  } catch (error) {
    if (error instanceof AdminAuthError) return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    console.error('Admin price list error', error);
    return NextResponse.json({ success: false, error: 'Could not load prices' }, { status: 500 });
  }
}

/**
 * PUT { prices: { [key]: number } } — only the keys being changed need to be sent.
 * A price equal to its default removes the override, so the code default applies again.
 */
export async function PUT(request: Request) {
  try {
    const { user } = await requireAdmin(request, ['ADMIN']);
    const body = await request.json();
    if (!body?.prices || typeof body.prices !== 'object' || Array.isArray(body.prices)) {
      return NextResponse.json({ success: false, error: 'No price changes were provided.' }, { status: 400 });
    }

    const updates: Array<{ key: string; price: number }> = [];
    for (const [key, raw] of Object.entries(body.prices as Record<string, unknown>)) {
      if (!(key in DEFAULT_PRICES)) return NextResponse.json({ success: false, error: `Unknown price: ${key}` }, { status: 400 });
      const price = Number(raw);
      if (raw === '' || raw === null || !Number.isFinite(price) || price < 0 || price > MAX_PRICE || Math.abs(Math.round(price * 100) - price * 100) > 1e-6) {
        const label = PRICE_DEFINITIONS.find(def => def.key === key)?.label || key;
        return NextResponse.json({ success: false, error: `${label}: enter an amount between R0 and R${MAX_PRICE} with at most 2 decimals.` }, { status: 400 });
      }
      updates.push({ key, price: Math.round(price * 100) / 100 });
    }
    if (!updates.length) return NextResponse.json({ success: false, error: 'No price changes were provided.' }, { status: 400 });

    const before = mergePrices(await getStoredPrices());
    const changes = updates.filter(update => before[update.key] !== update.price);
    if (!changes.length) return NextResponse.json({ success: true, message: 'Prices are already up to date.' });

    const now = new Date().toISOString();
    const toStore = changes.filter(change => change.price !== DEFAULT_PRICES[change.key]);
    const toReset = changes.filter(change => change.price === DEFAULT_PRICES[change.key]).map(change => change.key);
    if (toStore.length) {
      const { error } = await supabase.from('price_settings').upsert(toStore.map(change => ({ ...change, updated_at: now, updated_by: user.id })), { onConflict: 'key' });
      if (error) throw error;
    }
    if (toReset.length) {
      const { error } = await supabase.from('price_settings').delete().in('key', toReset);
      if (error) throw error;
    }

    await writeAudit(user.id, 'UPDATE_PRICES', 'price_settings', 'prices', {
      changes: changes.map(change => ({ key: change.key, from: before[change.key], to: change.price })),
    });
    return NextResponse.json({ success: true, message: `${changes.length} price${changes.length === 1 ? '' : 's'} updated. New bookings use the new prices immediately.` });
  } catch (error) {
    if (error instanceof AdminAuthError) return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    console.error('Admin price update error', error);
    return NextResponse.json({ success: false, error: 'Could not update prices. Check that the latest database migration has been applied.' }, { status: 500 });
  }
}
