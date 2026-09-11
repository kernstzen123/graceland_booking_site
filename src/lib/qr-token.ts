import crypto from 'crypto';

type QrClaims = { v: 1; bid: string; tid: string; nonce: string; exp: number };

function secret() {
  const value = process.env.QR_SIGNING_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!value) throw new Error('QR_SIGNING_SECRET is not configured');
  return value;
}

function encode(value: string) {
  return Buffer.from(value).toString('base64url');
}

function signature(payload: string) {
  return crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
}

export function createQrToken(bookingId: string, ticketUid: string, visitDate: string) {
  const expiry = new Date(`${visitDate}T23:59:59.999Z`).getTime();
  const claims: QrClaims = { v: 1, bid: bookingId, tid: ticketUid, nonce: crypto.randomBytes(18).toString('base64url'), exp: Math.floor(expiry / 1000) };
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
    if (claims.v !== 1 || typeof claims.bid !== 'string' || typeof claims.tid !== 'string' || typeof claims.nonce !== 'string' || !Number.isInteger(claims.exp) || claims.exp < Math.floor(Date.now() / 1000)) return null;
    return claims;
  } catch {
    return null;
  }
}
