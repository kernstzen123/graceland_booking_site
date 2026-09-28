import 'server-only';
import { supabase } from '@/lib/supabase';

export type AdminRole = 'ADMIN' | 'MANAGER' | 'SCANNER';

export async function requireAdmin(request: Request, allowedRoles?: AdminRole[]) {
  const authorization = request.headers.get('authorization');
  const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!token) throw new AdminAuthError('Authentication required', 401);

  // getClaims verifies the token's signature and expiry locally when the project
  // uses asymmetric JWT signing keys (the public keys are fetched once and cached),
  // saving a round trip to Supabase Auth on every admin request. With legacy
  // shared-secret keys it falls back to the same server check as getUser().
  // Deactivated or deleted staff are still rejected by the admin_roles check below.
  // getClaims throws (rather than returning an error) on tokens it cannot decode.
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims(token).catch(() => ({ data: null, error: new Error('Malformed token') }));
  const claims = claimsData?.claims;
  if (claimsError || !claims?.sub || claims.role !== 'authenticated') throw new AdminAuthError('Invalid or expired session', 401);
  const user = { id: claims.sub, email: typeof claims.email === 'string' ? claims.email : undefined };

  const { data: roleRow, error: roleError } = await supabase
    .from('admin_roles')
    .select('role,active')
    .eq('id', user.id)
    .maybeSingle();
  if (roleError || !roleRow || roleRow.active === false) throw new AdminAuthError('Staff access is required', 403);

  const role = String(roleRow.role).toUpperCase() as AdminRole;
  if (allowedRoles && !allowedRoles.includes(role)) throw new AdminAuthError('Insufficient staff permissions', 403);
  return { user, role };
}

export async function writeAudit(userId: string, action: string, entityType: string, entityId: string, details: Record<string, unknown> = {}) {
  const { data: actor } = await supabase.auth.admin.getUserById(userId);
  const { error } = await supabase.from('admin_audit_log').insert({
    actor_id: userId, actor_email: actor.user?.email || null, action, entity_type: entityType, entity_id: entityId, details: redactAuditDetails(details),
  });
  if (error) console.error('Could not write admin audit log', error);
}

/** A voucher code works like cash, so logs only keep enough to recognise it: GRC-1A2B3C4D → GRC-****3C4D. */
export function maskVoucherCode(code: string) {
  const value = code.trim();
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

const VOUCHER_CODE_KEYS = new Set(['credit_code', 'creditCode', 'code', 'voucher_code', 'voucherCode']);

/** Mask voucher codes in audit details. Used when writing entries and when showing older ones. */
export function redactAuditDetails(details: Record<string, unknown>): Record<string, unknown> {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return details;
  return Object.fromEntries(Object.entries(details).map(([key, value]) => [key, VOUCHER_CODE_KEYS.has(key) && typeof value === 'string' ? maskVoucherCode(value) : value]));
}

export class AdminAuthError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}
