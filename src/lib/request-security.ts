import 'server-only';
import crypto from 'crypto';
import { supabase } from '@/lib/supabase';

export function cleanText(value: unknown, maxLength: number) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLength) : '';
}

export function isValidEmail(value: string) {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function getClientAddress(request: Request) {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || request.headers.get('x-real-ip') || request.headers.get('cf-connecting-ip') || 'unknown';
}

function rateLimitKey(request: Request, scope: string, identity: string) {
  return crypto.createHash('sha256').update(`${scope}:${getClientAddress(request)}:${identity}`).digest('hex');
}

/** Wrong voucher codes allowed per address before it is locked out (guessing protection). */
export const VOUCHER_FAILURE_SCOPE = 'voucher-failed';
export const VOUCHER_FAILURE_LIMIT = 10;
export const VOUCHER_FAILURE_WINDOW = 60 * 60;

/**
 * Whether the limit for this scope has already been reached, without counting
 * this request. Pair with checkRateLimit to count only failures, e.g. wrong
 * voucher codes.
 */
export async function isRateLimited(request: Request, scope: string, limit: number, windowSeconds: number, identity = '') {
  const { data, error } = await supabase.from('api_rate_limits').select('window_started,request_count').eq('rate_key', rateLimitKey(request, scope, identity)).maybeSingle();
  if (error) throw error;
  if (!data) return false;
  const windowOpen = new Date(data.window_started).getTime() + windowSeconds * 1000 > Date.now();
  return windowOpen && Number(data.request_count) >= limit;
}

export async function checkRateLimit(request: Request, scope: string, limit: number, windowSeconds: number, identity = '') {
  const key = rateLimitKey(request, scope, identity);
  const { data, error } = await supabase.rpc('check_api_rate_limit', {
    p_key: key,
    p_limit: limit,
    p_window_seconds: windowSeconds,
  });
  if (error) throw error;
  return Boolean(data);
}
