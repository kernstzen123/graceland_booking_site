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

export async function checkRateLimit(request: Request, scope: string, limit: number, windowSeconds: number, identity = '') {
  const address = getClientAddress(request);
  const key = crypto.createHash('sha256').update(`${scope}:${address}:${identity}`).digest('hex');
  const { data, error } = await supabase.rpc('check_api_rate_limit', {
    p_key: key,
    p_limit: limit,
    p_window_seconds: windowSeconds,
  });
  if (error) throw error;
  return Boolean(data);
}
