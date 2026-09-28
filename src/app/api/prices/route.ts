import { NextResponse } from 'next/server';
import { getCurrentPrices } from '@/lib/price-store';
import { checkRateLimit } from '@/lib/request-security';

/**
 * GET /api/prices
 *
 * The prices currently charged, keyed by price key (see PRICE_DEFINITIONS in
 * src/lib/pricing.ts). The booking page prices the basket with these, and the
 * booking API recalculates with the same values.
 */
export async function GET(request: Request) {
  try {
    if (!(await checkRateLimit(request, 'prices', 60, 60))) return NextResponse.json({ error: 'Too many requests. Please wait a moment and try again.' }, { status: 429 });
    const prices = await getCurrentPrices();
    return NextResponse.json({ prices }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('Price list error', error);
    return NextResponse.json({ error: 'Prices are temporarily unavailable.' }, { status: 500 });
  }
}
