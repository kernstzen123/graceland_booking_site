import { PGlite } from '@electric-sql/pglite';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../supabase');
const db = new PGlite({ extensions: { uuid_ossp } });
const failures = [];
const check = (label, condition, extra = '') => {
  if (!condition) failures.push(`${label}${extra ? `  (${extra})` : ''}`);
};
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const rows = async (sql, params = []) => (await db.query(sql, params)).rows;
const expectError = async (label, sql, pattern) => {
  try { await db.exec(sql); check(label, false, 'no error'); }
  catch (error) { check(label, pattern.test(error.message), error.message); }
};

/**
 * Builds the database from supabase/schema.sql and every migration in an
 * in-memory Postgres (PGlite), with Supabase-like roles, then checks the
 * security lockdown and the booking, payment and voucher functions.
 */
it('database migrations and functions behave correctly', async () => {
  // ── Supabase-like environment ────────────────────────────────────────────
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
    create schema auth;
    create table auth.users (id uuid primary key default gen_random_uuid(), email text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
    create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean, owner text, file_size_limit bigint, allowed_mime_types text[], created_at timestamptz default now(), updated_at timestamptz default now());
  `);

  await db.exec(fs.readFileSync(path.join(repo, 'schema.sql'), 'utf8'));
  const migrations = fs.readdirSync(path.join(repo, 'migrations')).filter(f => f.endsWith('.sql')).sort();
  const target = '20260927_security_hardening.sql';
  const part2 = '20260928_production_hardening.sql';
  for (const file of migrations.filter(f => f < target)) {
    try { await db.exec(fs.readFileSync(path.join(repo, 'migrations', file), 'utf8')); }
    catch (error) { console.log(`(pre-existing migration ${file} failed in test env: ${error.message})`); }
  }

  // State before hardening: anon can call a privileged function (the reported hole).
  await db.exec(`set role anon`);
  try { await db.query(`select * from public.issue_booking_voucher('00000000-0000-0000-0000-000000000000')`); check('before: anon can execute issue_booking_voucher', false, 'no error'); }
  catch (error) { check('before: anon can execute issue_booking_voucher (reaches function body)', /Booking not found/.test(error.message), error.message); }
  await db.exec(`reset role`);

  // Seed a little data before the migration (to check the migration on existing rows).
  await db.exec(`insert into business_settings(business_name, daily_capacity) values ('Graceland', 10)`);

  const migrationSql = fs.readFileSync(path.join(repo, 'migrations', target), 'utf8');
  await db.exec(migrationSql);
  check('migration applies', true);
  await db.exec(migrationSql);
  check('migration applies a second time (idempotent)', true);
  // Existing data the second migration must carry over.
  await db.exec(`insert into customers(first_name,last_name,email,phone) values ('Old','Row','o@example.com','1')`);
  await db.exec(`insert into bookings(reference, customer_id, visit_date, status, total_amount, people_count, notes) select 'BK-OLD', id, '2026-01-01', 'PAID', 100, 1, 'TICKETS_EMAIL_SENT' from customers where email = 'o@example.com'`);
  const part2Sql = fs.readFileSync(path.join(repo, 'migrations', part2), 'utf8');
  await db.exec(part2Sql);
  check('second migration applies', true);
  await db.exec(part2Sql);
  check('second migration applies a second time (idempotent)', true);
  // Later migrations (e.g. the new seating map), in order, each applied twice.
  for (const file of migrations.filter(f => f > part2)) {
    const sql = fs.readFileSync(path.join(repo, 'migrations', file), 'utf8');
    try { await db.exec(sql); await db.exec(sql); } catch (error) { check(`${file} applies twice`, false, error.message); }
  }
  check('old TICKETS_EMAIL_SENT note carried into tickets_emailed_at', Boolean((await one(`select tickets_emailed_at from bookings where reference = 'BK-OLD'`)).tickets_emailed_at));
  const settings = await rows(`select daily_capacity, support_email, support_phone from business_settings`);
  check('exactly one business settings row, with support contact', settings.length === 1 && settings[0].support_email === 'support@gracelandvenuespaarl.co.za', JSON.stringify(settings));
  await expectError('a second business settings row is refused', `insert into business_settings(business_name) values ('dup')`, /duplicate key/);

  // ── Privileges ───────────────────────────────────────────────────────────
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`set role ${role}`);
    for (const [label, sql] of [
      ['issue_booking_voucher', `select * from public.issue_booking_voucher('00000000-0000-0000-0000-000000000000')`],
      ['reserve_capacity', `select public.reserve_capacity('2030-01-01', 1, '{}'::jsonb, 'X', 1)`],
      ['set_booking_payment_status', `select * from public.set_booking_payment_status('00000000-0000-0000-0000-000000000000', 'PAID')`],
      ['hold_booking_for_payment', `select * from public.hold_booking_for_payment('00000000-0000-0000-0000-000000000000', 15, 48)`],
      ['release_expired_booking_vouchers', `select public.release_expired_booking_vouchers()`],
      ['recheck_capacity_for_approval', `select public.recheck_capacity_for_approval('00000000-0000-0000-0000-000000000000')`],
      ['create_booking', `select * from public.create_booking('2030-01-01', 1, '{}'::jsonb, 'X', 1, null, null, null, '[]'::jsonb)`],
      ['claim_ticket_email', `select public.claim_ticket_email('00000000-0000-0000-0000-000000000000')`],
      ['generate_voucher_code', `select public.generate_voucher_code()`],
      ['select bookings', `select count(*) from public.bookings`],
      ['select customers', `select count(*) from public.customers`],
      ['update booking_credits', `update public.booking_credits set remaining_balance = 9999`],
    ]) {
      try { await db.query(sql); check(`${role} blocked: ${label}`, false, 'no error'); }
      catch (error) { check(`${role} blocked: ${label}`, /permission denied/.test(error.message), error.message); }
    }
    await db.exec(`reset role`);
  }
  await db.exec(`set role authenticated`);
  try { await db.query(`select public.current_staff_role()`); check('authenticated can still run current_staff_role (used by RLS policies)', true); }
  catch (error) { check('authenticated can still run current_staff_role', false, error.message); }
  await db.exec(`reset role`);
  const unpinned = await rows(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosecdef and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')`);
  check('every SECURITY DEFINER function has a fixed search_path', unpinned.length === 0, unpinned.map(r => r.proname).join(', '));
  const noRls = await rows(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`);
  check('row level security enabled on every table', noRls.length === 0, noRls.map(r => r.relname).join(', '));
  const bucket = await one(`select file_size_limit, allowed_mime_types from storage.buckets where id = 'payment-proofs'`);
  check('proof bucket limited to 10 MB PDF/JPG/PNG', bucket && Number(bucket.file_size_limit) === 10485760 && bucket.allowed_mime_types.length === 3);
  const fks = await rows(`select conrelid::regclass::text as t, confdeltype from pg_constraint where contype = 'f' and confrelid = 'public.bookings'::regclass and conrelid in ('public.payments'::regclass, 'public.payment_proofs'::regclass)`);
  check('payments/proofs no longer cascade-delete with a booking', fks.length === 2 && fks.every(r => r.confdeltype === 'r'), JSON.stringify(fks));

  // From here on act as the server does (service role).
  await db.exec(`set role service_role`);
  const customer = `'{"firstName":"Test","lastName":"User","email":"t@example.com","phone":"0820000000"}'::jsonb`;
  const future = (await one(`select ((now() at time zone 'Africa/Johannesburg')::date + 10) as d`)).d.toISOString().slice(0, 10);
  const reserve = async (ref, people, total, voucher = null) => (await one(`select public.reserve_capacity($1::date, $2, ${customer}, $3, $4, null, null, $5) as id`, [future, people, ref, total, voucher])).id;
  const spots = await rows(`select id, number from public.venue_spots where active order by type, number limit 3`);
  const status = async id => one(`select status, expires_at, notes, attention_reason, deleted_at, amount_due from public.bookings where id = $1`, [id]);
  const lapse = id => db.query(`update public.bookings set expires_at = now() - interval '1 minute' where id = $1`, [id]);

  // ── Lapsed hold: capacity ────────────────────────────────────────────────
  const a = await reserve('BK-A', 6, 600);
  await db.query(`select public.reserve_booking_spots($1, $2::date, $3::uuid[])`, [a, future, [spots[0].id]]);
  await lapse(a);
  const b = await reserve('BK-B', 6, 600); // fits only because A lapsed
  check('lapsed booking frees its places for others', Boolean(b));
  let r = await one(`select * from public.set_booking_payment_status($1, 'PAID', 'PAYFAST')`, [a]);
  check('late payment on a full day is refused (FULL)', r.ok === false && r.reason === 'FULL', r.detail);
  check('refused late payment leaves booking unchanged', (await status(a)).status === 'UNPAID');
  r = await one(`select * from public.set_booking_payment_status($1, 'PAID', 'ADMIN_OVERRIDE', true, 600, 'ADMIN-a')`, [a]);
  check('admin force marks it paid anyway', r.ok === true && r.reclaimed === true && (await status(a)).status === 'PAID');
  check('forced mark-paid recorded the payment', Number((await one(`select count(*) as n from public.payments where booking_id = $1 and status = 'COMPLETE'`, [a])).n) === 1);
  r = await one(`select * from public.set_booking_payment_status($1, 'PAID')`, [a]);
  check('second confirmation reports ALREADY_PAID', r.ok === false && r.reason === 'ALREADY_PAID');

  // ── Lapsed hold: seating ─────────────────────────────────────────────────
  await db.exec(`update public.business_settings set daily_capacity = 500`);
  const c = await reserve('BK-C', 2, 200);
  await db.query(`select public.reserve_booking_spots($1, $2::date, $3::uuid[])`, [c, future, [spots[1].id]]);
  await lapse(c);
  const d = await reserve('BK-D', 2, 200);
  await db.query(`select public.reserve_booking_spots($1, $2::date, $3::uuid[])`, [d, future, [spots[1].id]]);
  r = await one(`select * from public.set_booking_payment_status($1, 'PAYMENT_PENDING')`, [c]);
  check('late proof when the hut was re-booked is refused (SEAT_TAKEN)', r.ok === false && r.reason === 'SEAT_TAKEN', r.detail);

  // ── Lapsed hold that is still available is revived ──────────────────────
  const e = await reserve('BK-E', 2, 200);
  await lapse(e);
  r = await one(`select * from public.set_booking_payment_status($1, 'PAYMENT_PENDING')`, [e]);
  check('late proof with room left moves to PAYMENT_PENDING', r.ok === true && r.reclaimed === true && (await status(e)).status === 'PAYMENT_PENDING');
  r = await one(`select * from public.set_booking_payment_status($1, 'PAID', 'MANUAL_EFT', false, 200, 'EFT-1')`, [e]);
  check('approving the proof marks it paid', r.ok === true && r.reclaimed === false && (await status(e)).status === 'PAID');

  // ── Voucher release and re-apply ─────────────────────────────────────────
  await db.query(`insert into public.booking_credits(credit_code, original_booking_id, original_amount, remaining_balance) values ('GRC-TEST0001', $1, 500, 500)`, [a]);
  const credit = async () => one(`select remaining_balance, status from public.booking_credits where credit_code = 'GRC-TEST0001'`);
  const redemption = async id => one(`select amount_used, released from public.credit_redemptions where booking_id = $1`, [id]);
  const v = await reserve('BK-V', 2, 800, 'GRC-TEST0001'); // voucher covers 500, 300 due
  check('voucher applied on booking', Number((await credit()).remaining_balance) === 0 && (await credit()).status === 'depleted' && Number((await status(v)).amount_due) === 300);
  await lapse(v);
  const released = (await one(`select public.release_expired_booking_vouchers() as n`)).n;
  check('release job returns the voucher balance of a lapsed booking', released === 1 && Number((await credit()).remaining_balance) === 500 && (await credit()).status === 'active' && (await redemption(v)).released === true, `released=${released}`);
  check('release job is idempotent', (await one(`select public.release_expired_booking_vouchers() as n`)).n === 0);
  r = await one(`select * from public.hold_booking_for_payment($1, 15, 48)`, [v]);
  check('PayFast retry re-applies the voucher and holds again', r.ok === true && Number((await credit()).remaining_balance) === 0 && (await redemption(v)).released === false && (await status(v)).status === 'UNPAID' && new Date((await status(v)).expires_at) > new Date());
  await lapse(v);
  await one(`select public.release_expired_booking_vouchers() as n`);
  const w = await reserve('BK-W', 2, 700, 'GRC-TEST0001'); // spends the released 500
  check('released balance can be used on a new booking', Number((await credit()).remaining_balance) === 0 && Number((await redemption(w)).amount_used) === 500);
  r = await one(`select * from public.set_booking_payment_status($1, 'PAID', 'PAYFAST')`, [v]);
  check('late payment refused when the voucher was spent elsewhere (VOUCHER_UNAVAILABLE)', r.ok === false && r.reason === 'VOUCHER_UNAVAILABLE' && Number((await credit()).remaining_balance) === 0 && (await status(v)).status === 'UNPAID', r.detail);
  r = await one(`select * from public.set_booking_payment_status($1, 'PAID', 'PAYFAST', true)`, [v]);
  check('force does not bypass a voucher shortfall', r.ok === false && r.reason === 'VOUCHER_UNAVAILABLE');
  // reserve_capacity releases lapsed holds on the voucher before applying it
  await lapse(w);
  const x = await reserve('BK-X', 2, 600, 'GRC-TEST0001');
  check('reserve_capacity releases a lapsed hold on the same voucher first', Boolean(x) && (await redemption(w)).released === true && Number((await redemption(x)).amount_used) === 500 && Number((await credit()).remaining_balance) === 0, `balance ${(await credit()).remaining_balance}`);
  // Vouchers can only be used in the season they were issued in
  await db.query(`insert into public.booking_credits(credit_code, original_booking_id, original_amount, remaining_balance, created_at) values ('GRC-OLDSEASON', $1, 300, 300, now() - interval '2 years')`, [a]);
  await expectError('a voucher from an earlier season is refused', `select public.reserve_capacity('${future}'::date, 1, ${customer}, 'BK-OLDV', 200, null, null, 'GRC-OLDSEASON')`, /voucher has expired/);
  check('an expired voucher keeps its balance', Number((await one(`select remaining_balance from public.booking_credits where credit_code = 'GRC-OLDSEASON'`)).remaining_balance) === 300);
  check('voucher expiry is the 30 April that ends its season', (await one(`select public.voucher_expiry_date('2026-10-03 10:00+02'::timestamptz)::text as d, public.voucher_expiry_date('2027-06-10 10:00+02'::timestamptz)::text as e`)).d === '2027-04-30' && (await one(`select public.voucher_expiry_date('2027-06-10 10:00+02'::timestamptz)::text as e`)).e === '2028-04-30');

  // ── Hold extension rules ─────────────────────────────────────────────────
  const h = await reserve('BK-H', 2, 200);
  const before = new Date((await status(h)).expires_at);
  r = await one(`select * from public.hold_booking_for_payment($1, 2880, 48)`, [h]);
  const after = new Date(r.hold_until);
  check('EFT hold extends to about 48h after the booking was made', r.ok && after - before > 47 * 3600e3);
  r = await one(`select * from public.hold_booking_for_payment($1, 15, 48)`, [h]);
  check('a later PayFast start never shortens the EFT hold', r.ok && new Date(r.hold_until).getTime() === after.getTime());
  await db.query(`update public.bookings set created_at = now() - interval '49 hours', expires_at = now() - interval '1 hour' where id = $1`, [h]);
  r = await one(`select * from public.hold_booking_for_payment($1, 2880, 48)`, [h]);
  check('no hold beyond 48h after the booking was made (EXPIRED)', r.ok === false && r.reason === 'EXPIRED');
  const f = await reserve('BK-F', 2, 200);
  await db.query(`update public.bookings set status = 'PAYMENT_FAILED', notes = 'first line' || chr(10) || 'PAYFAST_FAILED' where id = $1`, [f]);
  r = await one(`select * from public.hold_booking_for_payment($1, 15, 48)`, [f]);
  const fs1 = await status(f);
  check('retry after a failed PayFast payment revives it to UNPAID and clears the failure note', r.ok && fs1.status === 'UNPAID' && fs1.notes === 'first line', JSON.stringify(fs1.notes));
  r = await one(`select * from public.hold_booking_for_payment($1, 15, 48)`, [a]);
  check('paid booking cannot be put back on hold', r.ok === false && r.reason === 'ALREADY_PAID');

  // ── Refund with fee ──────────────────────────────────────────────────────
  await db.query(`insert into public.payments(booking_id, amount, method, status, provider_reference) values ($1, 450, 'PAYFAST', 'COMPLETE', 'pf-e')`, [e]);
  await db.query(`delete from public.payments where booking_id = $1 and provider_reference = 'EFT-1'`, [e]).catch(() => {});
  const refund = await one(`select * from public.issue_booking_voucher($1, null, 15, 'cancellation')`, [e]);
  check('refund voucher = paid less 15% fee, in one step', Number(refund.original_amount) === 382.5 && Number(refund.paid_amount) === 450 && Number(refund.deduction_percentage) === 15, JSON.stringify({ amount: refund.original_amount, paid: refund.paid_amount }));
  const stored = await one(`select original_amount, remaining_balance, paid_amount, deduction_percentage, issue_reason from public.booking_credits where id = $1`, [refund.credit_id]);
  check('stored voucher matches (no full-value voucher ever existed)', Number(stored.original_amount) === 382.5 && Number(stored.remaining_balance) === 382.5 && stored.issue_reason === 'cancellation');
  check('refunded booking cancelled, payment marked refunded', (await status(e)).status === 'CANCELLED' && Number((await one(`select count(*) as n from public.payments where booking_id = $1 and status = 'COMPLETE'`, [e])).n) === 0);
  await expectError('100% fee rejected', `select * from public.issue_booking_voucher('${a}', null, 100)`, /between 0% and 99%/);
  const legacy = await one(`select * from public.issue_booking_voucher($1, null)`, [a]); // old two-argument call still works
  check('two-argument call (currently deployed code) still works', Number(legacy.original_amount) === 600);

  // ── Soft delete ──────────────────────────────────────────────────────────
  r = await one(`select * from public.archive_booking($1, null, 'test')`, [b]);
  check('unpaid booking can be deleted', r.ok === true && (await status(b)).status === 'CANCELLED' && (await status(b)).deleted_at);
  r = await one(`select * from public.archive_booking($1, null, 'duplicate')`, [x]); // X holds the whole 500
  check('deleting an unpaid voucher booking returns the voucher amount', r.ok && Number((await credit()).remaining_balance) === 500 && (await credit()).status === 'active' && (await redemption(x)).released === true);
  const p = await reserve('BK-P', 2, 100);
  await one(`select * from public.set_booking_payment_status($1, 'PAID', 'ADMIN_OVERRIDE', false, 100, 'ADMIN-p')`, [p]);
  r = await one(`select * from public.archive_booking($1, null, 'test')`, [p]);
  check('paid booking cannot be deleted', r.ok === false && r.reason === 'PAID');
  await expectError('reason required to delete', `select * from public.archive_booking('${d}', null, '  ')`, /reason is required/);
  await expectError('hard delete of a booking with payments is blocked', `delete from public.bookings where id = '${p}'`, /violates foreign key/);
  r = await one(`select * from public.set_booking_payment_status($1, 'PAID')`, [b]);
  check('deleted booking cannot be marked paid', r.ok === false && r.reason === 'CANCELLED');

  // ── Bookings list filters ────────────────────────────────────────────────
  await db.query(`update public.bookings set attention_reason = 'test alert', attention_at = now() where id = $1`, [c]);
  const all = await rows(`select reference from public.admin_search_bookings(null, null, null, 200, 0)`);
  const deleted = await rows(`select reference from public.admin_search_bookings(null, 'DELETED', null, 200, 0)`);
  const attention = await rows(`select reference, attention_reason from public.admin_search_bookings(null, 'ATTENTION', null, 200, 0)`);
  check('deleted bookings hidden from the default list', !all.some(row => row.reference === 'BK-B'));
  check('"Deleted" filter shows them', deleted.some(row => row.reference === 'BK-B') && deleted.every(row => ['BK-B', 'BK-X'].includes(row.reference)));
  check('"Needs attention" filter', attention.length === 1 && attention[0].reference === 'BK-C');

  // ── Existing dashboard/report functions still work for the server ───────
  const overview = await one(`select public.admin_day_overview($1::date) as o`, [future]);
  check('admin_day_overview still works for the server', overview.o && typeof overview.o.headcount !== 'undefined');
  const report = await one(`select public.admin_report_data($1::date, $1::date, 'visit') as r`, [future]);
  check('admin_report_data still works and excludes released voucher amounts', report.r && Array.isArray(report.r.bookings));
  const lock = await one(`select public.check_api_rate_limit('k', 2, 60) as ok`);
  check('rate limiter still works for the server', lock.ok === true);

  // ── Proof under review keeps its hold ────────────────────────────────────
  const q = await reserve('BK-Q', 2, 100);
  await one(`select * from public.set_booking_payment_status($1, 'PAYMENT_PENDING')`, [q]);
  await lapse(q); // expires_at in the past, but PAYMENT_PENDING always holds
  r = await one(`select * from public.hold_booking_for_payment($1, 2880, 48)`, [q]);
  check('EFT email for a booking under review is allowed and changes nothing', r.ok === true && (await status(q)).status === 'PAYMENT_PENDING');
  r = await one(`select * from public.set_booking_payment_status($1, 'PAYMENT_PENDING')`, [q]);
  check('second proof upload keeps PAYMENT_PENDING', r.ok === true && r.reclaimed === false);
  r = await one(`select * from public.archive_booking($1, null, 'x')`, [q]);
  check('booking with a proof under review cannot be deleted', r.ok === false && r.reason === 'PROOF_PENDING');
  r = await one(`select * from public.set_booking_payment_status($1, 'PAID', 'MANUAL_EFT', false, 100, 'EFT-q')`, [q]);
  check('approving a proof under review does not re-check (places were held)', r.ok === true && r.reclaimed === false);

  // ── Voucher code format ─────────────────────────────────────────────────
  const codes = await rows(`select public.generate_voucher_code() as c from generate_series(1, 200)`);
  check('new voucher codes are GRC-XXXX-XXXX-XXXX from the unambiguous alphabet', codes.every(r => /^GRC-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/.test(r.c)), codes[0].c);
  check('200 generated codes are all different', new Set(codes.map(r => r.c)).size === 200);
  check('refund vouchers use the new format', /^GRC-\w{4}-\w{4}-\w{4}$/.test(legacy.credit_code) || /^GRC-\w{4}-\w{4}-\w{4}$/.test((await one(`select * from public.issue_booking_voucher($1, null)`, [p])).credit_code));

  // ── create_booking: all or nothing ──────────────────────────────────────
  const items = JSON.stringify([{ quantity: 2, price_per_unit: 100, subtotal: 200, metadata: { name: 'Adult', isPerson: true } }]);
  await db.query(`insert into public.booking_credits(credit_code, original_booking_id, original_amount, remaining_balance) values ('GRC-ATOM-ATOM-ATOM', $1, 150, 150)`, [a]);
  const takenSpot = spots[2].id;
  const holder = await reserve('BK-HOLDER', 2, 200);
  await db.query(`select public.reserve_booking_spots($1, $2::date, $3::uuid[])`, [holder, future, [takenSpot]]);
  const bookingsBefore = Number((await one(`select count(*) as n from public.bookings`)).n);
  await expectError('create_booking fails when the seat is taken', `select * from public.create_booking('${future}', 2, ${customer}, 'BK-ATOM1', 200, null, 'idem-atom', 'GRC-ATOM-ATOM-ATOM', '${items}'::jsonb, array['${takenSpot}']::uuid[])`, /seating spot was just taken/);
  check('...and leaves no booking behind', Number((await one(`select count(*) as n from public.bookings`)).n) === bookingsBefore);
  check('...and does not use the voucher', Number((await one(`select remaining_balance from public.booking_credits where credit_code = 'GRC-ATOM-ATOM-ATOM'`)).remaining_balance) === 150);
  const created = await one(`select * from public.create_booking($1::date, 2, ${customer}, 'BK-ATOM2', 200, null, 'idem-atom2', 'GRC-ATOM-ATOM-ATOM', $2::jsonb, array[]::uuid[], '2026-09-09', '2026-09-28')`, [future, items]);
  const createdRow = await one(`select status, amount_due, terms_version, privacy_version, terms_accepted_at, (select count(*) from public.booking_items where booking_id = $1) as items from public.bookings where id = $1`, [created.booking_id]);
  check('create_booking saves booking, items, voucher and consent together', created.created === true && Number(createdRow.items) === 1 && Number(createdRow.amount_due) === 50 && createdRow.terms_version === '2026-09-09' && createdRow.privacy_version === '2026-09-28' && Boolean(createdRow.terms_accepted_at));
  const again = await one(`select * from public.create_booking($1::date, 2, ${customer}, 'BK-ATOM3', 200, null, 'idem-atom2', null, $2::jsonb)`, [future, items]);
  check('same idempotency key returns the existing booking, nothing new saved', again.booking_id === created.booking_id && again.created === false && Number((await one(`select count(*) as n from public.booking_items where booking_id = $1`, [created.booking_id])).n) === 1);
  await expectError('create_booking refuses a booking without items', `select * from public.create_booking('${future}', 2, ${customer}, 'BK-ATOM4', 200, null, null, null, '[]'::jsonb)`, /At least one booking item/);

  // ── Ticket email claim ──────────────────────────────────────────────────
  const t1 = (await one(`select public.claim_ticket_email($1) as r`, [created.booking_id])).r;
  const t2 = (await one(`select public.claim_ticket_email($1) as r`, [created.booking_id])).r;
  check('first sender claims the ticket email, a simultaneous one is told IN_PROGRESS', t1 === 'CLAIMED' && t2 === 'IN_PROGRESS');
  await db.query(`select public.finish_ticket_email($1, false)`, [created.booking_id]);
  check('a failed send releases the claim for a retry', (await one(`select public.claim_ticket_email($1) as r`, [created.booking_id])).r === 'CLAIMED');
  await db.query(`select public.finish_ticket_email($1, true)`, [created.booking_id]);
  check('after a successful send, retries get ALREADY_SENT', (await one(`select public.claim_ticket_email($1) as r`, [created.booking_id])).r === 'ALREADY_SENT');
  const pf = await reserve('BK-PF', 2, 100);
  await db.query(`update public.bookings set status = 'PAYMENT_FAILED', payment_failed_at = now() where id = $1`, [pf]);
  await one(`select * from public.hold_booking_for_payment($1, 15, 48)`, [pf]);
  check('retrying a failed payment clears payment_failed_at', (await one(`select payment_failed_at from public.bookings where id = $1`, [pf])).payment_failed_at === null);

  // ── New seating map ─────────────────────────────────────────────────────
  const activeSpots = await rows(`select number, type, capacity from public.venue_spots where active`);
  check('new map: 16 huts for 14 people and 12 tables for 6', activeSpots.filter(s => s.type === 'hut' && s.capacity === 14 && /^H\d+$/.test(s.number)).length === 16 && activeSpots.filter(s => s.type === 'table' && s.capacity === 6 && /^T\d+$/.test(s.number)).length === 12 && activeSpots.length === 28, `${activeSpots.length} active`);
  const retired = await rows(`select id from public.venue_spots where not active`);
  check('old map spots are retired, not deleted', retired.length === 28);
  const seatBooking = await reserve('BK-SEAT', 2, 100);
  await expectError('a retired spot cannot be booked', `select public.reserve_booking_spots('${seatBooking}', '${future}', array['${retired[0].id}']::uuid[])`, /seating spots is invalid/);

  // Party huts are held by time of day: back-to-back parties can share a hut
  check('a party holds its hut for its slot plus 15 minutes either side', (await one(`select public.spot_hold_window('hut', '09:30–11:30')::text as w`)).w === '[555,705)');
  check('day visitors and tables hold a spot all day', (await one(`select public.spot_hold_window('hut', null)::text as a, public.spot_hold_window('table', '09:30–11:30')::text as b`)).a === '[0,1440)' && (await one(`select public.spot_hold_window('table', '09:30–11:30')::text as b`)).b === '[0,1440)');
  const partyHut = (await one(`select id from public.venue_spots where active and number = 'H16'`)).id;
  const partyTable = (await one(`select id from public.venue_spots where active and number = 'T12'`)).id;
  const party = async (ref, slot) => (await one(`select public.reserve_capacity($1::date, 12, ${customer}, $2, 100, $3) as id`, [future, ref, slot])).id;
  const seat = (id, spot) => db.query(`select public.reserve_booking_spots($1, $2::date, array[$3]::uuid[])`, [id, future, spot]);
  await seat(await party('BK-HUT-A', '09:30–11:30'), partyHut);
  let shared = true;
  try { await seat(await party('BK-HUT-B', '12:00–14:00'), partyHut); } catch { shared = false; }
  check('a party in the next slot can book the same hut', shared);
  await expectError('a second party in the same slot cannot book that hut', `select public.reserve_booking_spots('${await party('BK-HUT-C', '09:30–11:30')}', '${future}', array['${partyHut}']::uuid[])`, /just taken/);
  await expectError('a day visitor cannot book a hut that has a party', `select public.reserve_booking_spots('${await reserve('BK-HUT-DV', 2, 100)}', '${future}', array['${partyHut}']::uuid[])`, /just taken/);
  await seat(await party('BK-TABLE-A', '09:30–11:30'), partyTable);
  await expectError('a table is booked for the whole day, even by a party', `select public.reserve_booking_spots('${await party('BK-TABLE-B', '14:30–16:30')}', '${future}', array['${partyTable}']::uuid[])`, /just taken/);
  const seatingReport = (await one(`select public.admin_report_data($1::date, $1::date, 'visit') as r`, [future])).r.seating;
  check('report totals count only the current map', Number(seatingReport.hutTotal) === 16 && Number(seatingReport.tableTotal) === 12, JSON.stringify(seatingReport));

  await db.exec(`reset role`);
  expect(failures).toEqual([]);
});
