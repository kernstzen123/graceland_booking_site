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
    actor_id: userId, actor_email: actor.user?.email || null, action, entity_type: entityType, entity_id: entityId, details,
  });
  if (error) console.error('Could not write admin audit log', error);
}

export class AdminAuthError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}
