import 'server-only';
import { NextResponse } from 'next/server';
import { AdminAuthError } from '@/lib/admin-auth';
import { SpecialInputError } from '@/lib/specials-server';

/** Specials set prices, so only admins and managers may see or change them (as with prices and closed dates). */
export const SPECIALS_ROLES: Array<'ADMIN' | 'MANAGER'> = ['ADMIN', 'MANAGER'];

/** Error response for the specials admin endpoints: staff-fixable messages as-is, anything else generic (details go to the log). */
export function specialsErrorResponse(error: unknown, fallback: string) {
  if (error instanceof AdminAuthError) return NextResponse.json({ error: error.message }, { status: error.status });
  if (error instanceof SpecialInputError) return NextResponse.json({ error: error.message }, { status: 400 });
  console.error(fallback, error);
  return NextResponse.json({ error: fallback }, { status: 500 });
}
