import 'server-only';
import crypto from 'crypto';
import { requireEnv } from './env';

/** tid is the ticket or meal voucher ID, or the booking reference for a booking QR code (one code for the whole booking). */
type QrClaims = { v: 1; bid: string; tid: string; nonce: string; exp: number; type?: 'ticket' | 'meal' | 'booking' };

function secret() {
  // QR_SIGNING_SECRET must be its own dedicated secret — never fall back to
  // SUPABASE_SERVICE_ROLE_KEY, which has a different rotation lifecycle.
  return requireEnv('QR_SIGNING_SECRET', 'dev-qr-secret-DO-NOT-USE-IN-PRODUCTION');
}

function encode(value: string) {
  return Buffer.from(value).toString('base64url');
}

function signature(payload: string) {
  return crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
}

export function createQrToken(bookingId: string, ticketUid: string, visitDate: string, type: 'ticket' | 'meal' | 'booking' = 'ticket') {
  const expiry = new Date(`${visitDate}T23:59:59.999Z`).getTime();
  const claims: QrClaims = { v: 1, bid: bookingId, tid: ticketUid, nonce: crypto.randomBytes(18).toString('base64url'), exp: Math.floor(expiry / 1000), type };
  const payload = encode(JSON.stringify(claims));
  return `${payload}.${signature(payload)}`;
}

export function verifyQrToken(token: string) {
  try {
    const [payload, providedSignature] = token.split('.');
    if (!payload || !providedSignature || !/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(providedSignature)) return null;
    const expected = signature(payload);
    const expectedBuffer = Buffer.from(expected);
    const providedBuffer = Buffer.from(providedSignature);
    if (expectedBuffer.length !== providedBuffer.length || !crypto.timingSafeEqual(expectedBuffer, providedBuffer)) return null;
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as QrClaims;
    // A booking code's date is checked against the booking itself at the gate (see createBookingQrToken).
    const expired = claims.type !== 'booking' && claims.exp < Math.floor(Date.now() / 1000);
    if (claims.v !== 1 || typeof claims.bid !== 'string' || typeof claims.tid !== 'string' || typeof claims.nonce !== 'string' || !Number.isInteger(claims.exp) || expired) return null;
    return claims;
  } catch {
    return null;
  }
}

/**
 * The QR code for a whole booking: staff scan it once to see the booking and
 * check the group in. Unlike ticket codes it does not stop working after the
 * visit date it was made for: the gate checks the booking's current visit date
 * and status instead, so the customer's code keeps working when staff move the
 * booking to another day.
 */
export function createBookingQrToken(bookingId: string, reference: string, visitDate: string) {
  return createQrToken(bookingId, reference, visitDate, 'booking');
}
