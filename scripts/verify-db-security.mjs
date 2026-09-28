/**
 * Check what the public (anon) key can do against the live database.
 * The anon key is shipped in every page, so it must not be able to read tables
 * or call database functions. Run after applying
 * supabase/migrations/20260927_security_hardening.sql:
 *
 *   node --env-file=.env.local scripts/verify-db-security.mjs
 *
 * Safe to run at any time: it only counts rows (no row data is fetched) and
 * calls functions with a made-up booking ID, so nothing can be changed even if
 * a check fails.
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, '');
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!url || !anonKey) {
  console.error('Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY (e.g. node --env-file=.env.local …).');
  process.exit(1);
}

const headers = { apikey: anonKey, Authorization: `Bearer ${anonKey}`, 'Content-Type': 'application/json' };
const NIL = '00000000-0000-0000-0000-000000000000';
let problems = 0;
const report = (ok, label, detail) => {
  if (!ok) problems++;
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
};

const TABLES = [
  'bookings', 'customers', 'booking_items', 'payments', 'payment_proofs', 'tickets', 'ticket_scans',
  'booking_credits', 'credit_redemptions', 'credit_void_log', 'booking_spots', 'venue_spots',
  'admin_roles', 'admin_audit_log', 'notification_failures', 'checkin_conflicts', 'api_rate_limits',
  'business_settings', 'packages', 'huts', 'price_settings', 'closed_dates',
];

// Calls chosen so that nothing happens even if the function runs.
const FUNCTIONS = [
  ['issue_booking_voucher', { p_booking_id: NIL }],
  ['redeem_booking_credit', { p_credit_code: 'GRC-00000000', p_booking_id: NIL, p_booking_total: 1 }],
  ['reserve_booking_spots', { p_booking_id: NIL, p_visit_date: '2000-01-01', p_spot_ids: [] }],
  ['recheck_capacity_for_approval', { p_booking_id: NIL }],
  ['set_booking_payment_status', { p_booking_id: NIL, p_status: 'PAID' }],
  ['hold_booking_for_payment', { p_booking_id: NIL, p_hold_minutes: 15, p_max_hold_hours: 48 }],
  ['archive_booking', { p_booking_id: NIL, p_actor: NIL, p_reason: 'security check' }],
  ['create_booking', { p_visit_date: '2000-01-01', p_people_count: 0, p_customer: {}, p_reference: 'SECURITY-CHECK', p_total_amount: 0, p_party_slot: null, p_idempotency_key: null, p_voucher_code: null, p_items: [] }],
  ['claim_ticket_email', { p_booking_id: NIL }],
  ['finish_ticket_email', { p_booking_id: NIL, p_sent: false }],
  ['generate_voucher_code', {}],
  ['admin_search_bookings', { p_query: 'no-such-booking-security-check', p_limit: 1 }],
  ['admin_day_overview', { p_date: '2000-01-01' }],
];

console.log(`Checking ${url} with the public anon key\n`);

for (const table of TABLES) {
  const response = await fetch(`${url}/rest/v1/${table}?select=*&limit=0`, { method: 'GET', headers: { ...headers, Prefer: 'count=exact' } });
  const total = response.headers.get('content-range')?.split('/')[1];
  if (response.status === 401 || response.status === 403) report(true, `table ${table}: access denied`);
  else if (response.status === 404) report(true, `table ${table}: not exposed`);
  else if (response.ok && total === '0') report(false, `table ${table}: readable, but no rows visible`, 'row level security is protecting it, but the anon key should have no access at all');
  else report(false, `table ${table}: ${total ?? '?'} rows visible to anyone`, `HTTP ${response.status}`);
}

for (const [name, args] of FUNCTIONS) {
  const response = await fetch(`${url}/rest/v1/rpc/${name}`, { method: 'POST', headers, body: JSON.stringify(args) });
  const body = await response.json().catch(() => ({}));
  const denied = response.status === 401 || response.status === 403 || body.code === '42501';
  const missing = response.status === 404 || body.code === 'PGRST202';
  report(denied || missing, `function ${name}: ${denied ? 'permission denied' : missing ? 'not exposed' : `ran for the anon key (HTTP ${response.status}${body.message ? `: ${body.message}` : ''})`}`);
}

console.log(problems ? `\n${problems} problem(s) found. Apply supabase/migrations/20260927_security_hardening.sql in the Supabase SQL editor.` : '\nThe anon key cannot read tables or call functions.');
process.exit(problems ? 1 : 0);
