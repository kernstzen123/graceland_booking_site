-- Security and money-safety hardening.
--
-- Apply this BEFORE deploying the matching application code. It is safe to run
-- while the current code is still live: every existing function keeps working
-- with the arguments the current code sends. Running it twice is harmless.
--
--   1. New columns: soft delete, "needs attention" flags, voucher release time,
--      refund fee details.
--   2. Payment records and proofs can no longer be removed by deleting a booking.
--   3. Size and file-type limits on the proof-of-payment bucket.
--   4. Voucher holds on abandoned bookings are released (the previous
--      release_expired_booking_vouchers referenced columns that do not exist).
--   5. Lapsed holds can only be revived after re-checking capacity, seating and
--      the voucher, under the same locks the booking flow uses.
--   6. Refunds apply the cancellation fee in the same transaction as the voucher.
--   7. Soft delete for bookings.
--   8. Bookings list: "Needs attention" and "Deleted" filters.
--   9. Lock down the API: the public (anon) key and signed-in users can no longer
--      call database functions or read/write tables directly. The app only uses
--      the service role on the server, so nothing in the app changes.
--  10. Row level security is switched on for every table, including the ones the
--      older migrations never enabled it for.
--  11. Schedule the voucher release every five minutes (pg_cron) and run it once now.
--
-- Future migrations: new functions are still executable by PUBLIC by default in
-- Postgres. End every migration that creates a function with:
--   revoke all on function public.<name>(<args>) from public, anon, authenticated;
--   grant execute on function public.<name>(<args>) to service_role;

begin;

-- ── 1. New columns ──────────────────────────────────────────────────────────
alter table public.bookings add column if not exists deleted_at timestamptz;
alter table public.bookings add column if not exists deleted_by uuid references auth.users(id) on delete set null;
alter table public.bookings add column if not exists delete_reason text;
-- Set when money arrived for a booking that could not be confirmed automatically
-- (e.g. paid after the reservation expired and the day filled up). Staff see
-- these under Bookings → Needs attention.
alter table public.bookings add column if not exists attention_reason text;
alter table public.bookings add column if not exists attention_at timestamptz;

alter table public.credit_redemptions add column if not exists released_at timestamptz;

-- What the customer paid, the fee taken off, and why the voucher was issued
-- ('closure' for "refund all for date", 'cancellation' otherwise). Used to word
-- the voucher email correctly, including when it is retried later.
alter table public.booking_credits add column if not exists paid_amount numeric(12,2);
alter table public.booking_credits add column if not exists deduction_percentage numeric(5,2) not null default 0;
alter table public.booking_credits add column if not exists issue_reason text;

create index if not exists bookings_attention_idx on public.bookings(attention_at desc) where attention_reason is not null;
create index if not exists bookings_deleted_idx on public.bookings(deleted_at desc) where deleted_at is not null;
-- A stored proof file can only be recorded once.
create unique index if not exists payment_proofs_file_url_unique on public.payment_proofs(file_url);

-- ── 2. Deleting a booking must never delete its payment records ────────────
do $$
declare
  v_constraint record;
begin
  for v_constraint in
    select c.conname, c.conrelid::regclass as table_name
    from pg_constraint c
    where c.contype = 'f'
      and c.confrelid = 'public.bookings'::regclass
      and c.conrelid in ('public.payments'::regclass, 'public.payment_proofs'::regclass)
      and c.confdeltype = 'c' -- ON DELETE CASCADE
  loop
    execute format('alter table %s drop constraint %I', v_constraint.table_name, v_constraint.conname);
    execute format('alter table %s add constraint %I foreign key (booking_id) references public.bookings(id) on delete restrict', v_constraint.table_name, v_constraint.conname);
  end loop;
end $$;

-- ── 3. Proof-of-payment uploads: 10 MB, PDF / JPG / PNG only ───────────────
-- The server also checks every file, so this is a second layer; if storage
-- permissions block it, the rest of the migration still applies.
do $$
begin
  update storage.buckets
  set public = false,
      file_size_limit = 10485760,
      allowed_mime_types = array['application/pdf', 'image/jpeg', 'image/png']
  where id = 'payment-proofs';
exception when others then
  raise notice 'Could not set the payment-proofs bucket limits (%). Set them in Storage > payment-proofs > Edit bucket: 10 MB, application/pdf, image/jpeg, image/png.', sqlerrm;
end $$;

-- ── 4. Release vouchers held by bookings whose reservation lapsed ──────────
-- The balance goes back on the voucher; the redemption row is kept (released)
-- so the amount can be re-applied if a late payment revives the booking.
-- p_credit_id limits the release to one voucher (used just before a voucher is
-- applied, so a customer who abandoned a checkout can use it again straight away).
drop function if exists public.release_expired_booking_vouchers();

create or replace function public.release_expired_booking_vouchers(p_credit_id uuid default null)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row record;
  v_count integer := 0;
begin
  for v_row in
    select cr.id, cr.credit_id, cr.amount_used
    from public.credit_redemptions cr
    join public.bookings b on b.id = cr.booking_id
    where not cr.released
      and (p_credit_id is null or cr.credit_id = p_credit_id)
      and b.status in ('UNPAID', 'PAYMENT_FAILED')
      and (b.expires_at is null or b.expires_at <= now())
    order by cr.credit_id
    for update of cr skip locked
  loop
    update public.booking_credits bc
       set remaining_balance = least(bc.original_amount, bc.remaining_balance + v_row.amount_used),
           status = case when bc.status = 'depleted' then 'active' else bc.status end
     where bc.id = v_row.credit_id;
    update public.credit_redemptions cr
       set released = true, released_at = now()
     where cr.id = v_row.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- reserve_capacity: unchanged, except that it first releases lapsed holds on the
-- voucher being applied.
create or replace function public.reserve_capacity(
  p_visit_date date, p_people_count integer, p_customer jsonb, p_reference text,
  p_total_amount decimal, p_party_slot text default null, p_idempotency_key text default null,
  p_voucher_code text default null
) returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_customer_id uuid; v_booking_id uuid; v_current_count integer; v_max_capacity integer;
  v_voucher_used numeric(12,2) := 0; v_amount_due numeric(12,2) := p_total_amount;
  v_credit public.booking_credits%rowtype;
  v_credit_id uuid;
begin
  if p_idempotency_key is not null then
    select id into v_booking_id from public.bookings where idempotency_key = p_idempotency_key limit 1;
    if v_booking_id is not null then return v_booking_id; end if;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('graceland-booking-' || p_visit_date::text, 0));

  -- Multiple parties can share a time slot as long as they book different huts.
  -- Hut overlap protection is handled in reserve_booking_spots.

  select coalesce(sum(people_count), 0) into v_current_count from public.bookings where visit_date = p_visit_date and status in ('CONFIRMED','PAID','PAYMENT_PENDING','UNPAID') and (status <> 'UNPAID' or expires_at > now());
  select daily_capacity into v_max_capacity from public.business_settings limit 1; if v_max_capacity is null then v_max_capacity := 500; end if;
  if v_current_count + p_people_count > v_max_capacity then raise exception 'Capacity exceeded. Only % spots left.', (v_max_capacity - v_current_count); end if;
  if p_voucher_code is not null and trim(p_voucher_code) <> '' then
    select id into v_credit_id from public.booking_credits where upper(credit_code) = upper(trim(p_voucher_code));
    if v_credit_id is not null then perform public.release_expired_booking_vouchers(v_credit_id); end if;
    select * into v_credit from public.booking_credits where upper(credit_code) = upper(trim(p_voucher_code)) for update;
    if not found or v_credit.status <> 'active' or v_credit.remaining_balance <= 0 then raise exception 'That voucher code is invalid or has no remaining balance'; end if;
    v_voucher_used := least(v_credit.remaining_balance, p_total_amount)::numeric(12,2); v_amount_due := greatest(p_total_amount - v_voucher_used, 0);
  end if;
  insert into public.customers(first_name,last_name,email,phone) values (p_customer->>'firstName',p_customer->>'lastName',p_customer->>'email',p_customer->>'phone') returning id into v_customer_id;
  insert into public.bookings(reference,customer_id,visit_date,status,total_amount,people_count,expires_at,party_slot,idempotency_key,voucher_amount_used,amount_due)
    values(p_reference,v_customer_id,p_visit_date,case when v_amount_due = 0 then 'PAID' else 'UNPAID' end,p_total_amount,p_people_count,now()+interval '15 minutes',p_party_slot,p_idempotency_key,v_voucher_used,v_amount_due) returning id into v_booking_id;
  if v_voucher_used > 0 then
    insert into public.credit_redemptions(credit_id,booking_id,amount_used) values(v_credit.id,v_booking_id,v_voucher_used);
    update public.booking_credits set remaining_balance = remaining_balance - v_voucher_used, status = case when remaining_balance - v_voucher_used <= 0 then 'depleted' else 'active' end where id = v_credit.id;
    update public.bookings set voucher_credit_id = v_credit.id where id = v_booking_id;
  end if;
  return v_booking_id;
end;
$$;

-- ── 5. Reviving a lapsed hold ──────────────────────────────────────────────
-- A booking "holds" its places while it is PAYMENT_PENDING, or UNPAID with
-- expires_at in the future. Once the hold lapses (or PayFast reports a failed
-- payment) those places, seats and voucher balance are free for other customers.
-- reclaim_booking_hold checks they are all still available, under the same
-- advisory locks as reserve_capacity and reserve_booking_spots, and re-applies
-- the voucher. The caller must hold a row lock on the booking and change its
-- status in the same transaction. p_force (admins only) skips the capacity,
-- seating and date checks; a voucher shortfall is never skipped.
create or replace function public.reclaim_booking_hold(p_booking_id uuid, p_force boolean default false)
returns table(ok boolean, reason text, detail text)
language plpgsql security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
declare
  v_booking public.bookings%rowtype;
  v_capacity integer;
  v_taken integer;
  v_spots text;
  v_row record;
  v_credit public.booking_credits%rowtype;
  v_today date := (now() at time zone 'Africa/Johannesburg')::date;
begin
  select * into v_booking from public.bookings b where b.id = p_booking_id;
  if not found then
    return query select false, 'NOT_FOUND'::text, 'Booking not found'::text; return;
  end if;

  if not p_force then
    if v_booking.visit_date < v_today then
      return query select false, 'DATE_PASSED'::text, format('The visit date (%s) has already passed.', to_char(v_booking.visit_date, 'FMDD Mon YYYY')); return;
    end if;
    if exists (select 1 from public.closed_dates cd where cd.date = v_booking.visit_date) then
      return query select false, 'DATE_CLOSED'::text, format('Graceland has since been closed on %s.', to_char(v_booking.visit_date, 'FMDD Mon YYYY')); return;
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('graceland-booking-' || v_booking.visit_date::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('graceland-seating-' || v_booking.visit_date::text, 0));

  if not p_force then
    select coalesce(sum(b.people_count), 0) into v_taken
      from public.bookings b
     where b.visit_date = v_booking.visit_date and b.id <> v_booking.id
       and b.status in ('CONFIRMED', 'PAID', 'PAYMENT_PENDING', 'UNPAID')
       and (b.status <> 'UNPAID' or b.expires_at > now());
    select bs.daily_capacity into v_capacity from public.business_settings bs limit 1;
    if v_capacity is null then v_capacity := 500; end if;
    if v_taken + v_booking.people_count > v_capacity then
      return query select false, 'FULL'::text,
        format('%s is now full: %s place%s left, %s needed.', to_char(v_booking.visit_date, 'FMDD Mon YYYY'),
               greatest(v_capacity - v_taken, 0), case when v_capacity - v_taken = 1 then '' else 's' end, v_booking.people_count);
      return;
    end if;

    select string_agg(case when vs.type = 'table' then 'Table ' else 'Hut ' end || vs.number, ', ' order by vs.number) into v_spots
      from public.booking_spots mine
      join public.venue_spots vs on vs.id = mine.spot_id
     where mine.booking_id = v_booking.id
       and exists (
         select 1 from public.booking_spots other
         join public.bookings ob on ob.id = other.booking_id
         where other.spot_id = mine.spot_id and other.visit_date = v_booking.visit_date
           and other.booking_id <> v_booking.id
           and ob.status in ('UNPAID', 'PAYMENT_PENDING', 'PAID', 'CONFIRMED')
           and (ob.status <> 'UNPAID' or ob.expires_at > now()));
    if v_spots is not null then
      return query select false, 'SEAT_TAKEN'::text, format('%s has since been booked by another customer.', v_spots); return;
    end if;
  end if;

  -- Check every released voucher amount first, then re-apply them, so nothing is
  -- changed when one of them is no longer available.
  for v_row in
    select cr.id, cr.credit_id, cr.amount_used from public.credit_redemptions cr
     where cr.booking_id = v_booking.id and cr.released order by cr.credit_id
  loop
    select * into v_credit from public.booking_credits bc where bc.id = v_row.credit_id for update;
    if v_credit.status = 'void' or v_credit.remaining_balance < v_row.amount_used then
      return query select false, 'VOUCHER_UNAVAILABLE'::text,
        format('The voucher on this booking covered R %s but now has R %s left.', to_char(v_row.amount_used, 'FM999999990.00'),
               to_char(case when v_credit.status = 'void' then 0 else v_credit.remaining_balance end, 'FM999999990.00'));
      return;
    end if;
  end loop;
  for v_row in
    select cr.id, cr.credit_id, cr.amount_used from public.credit_redemptions cr
     where cr.booking_id = v_booking.id and cr.released order by cr.credit_id
  loop
    update public.booking_credits bc
       set remaining_balance = bc.remaining_balance - v_row.amount_used,
           status = case when bc.remaining_balance - v_row.amount_used <= 0 then 'depleted' else 'active' end
     where bc.id = v_row.credit_id;
    update public.credit_redemptions cr set released = false, released_at = null where cr.id = v_row.id;
  end loop;

  return query select true, null::text, null::text;
end;
$$;

-- Keep (or win back) the reservation while the customer pays. Used when EFT
-- instructions are sent and when a PayFast payment starts. The hold becomes
-- now + p_hold_minutes, but never later than created_at + p_max_hold_hours, and
-- is never shortened. A lapsed or failed booking is only revived after
-- reclaim_booking_hold succeeds.
create or replace function public.hold_booking_for_payment(p_booking_id uuid, p_hold_minutes integer, p_max_hold_hours integer)
returns table(ok boolean, reason text, detail text, hold_until timestamptz)
language plpgsql security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
declare
  v_booking public.bookings%rowtype;
  v_until timestamptz;
  v_check record;
begin
  if p_hold_minutes is null or p_hold_minutes < 1 or p_max_hold_hours is null or p_max_hold_hours < 1 then
    raise exception 'Invalid hold length';
  end if;
  select * into v_booking from public.bookings b where b.id = p_booking_id for no key update;
  if not found then
    return query select false, 'NOT_FOUND'::text, 'Booking not found'::text, null::timestamptz; return;
  end if;
  if v_booking.deleted_at is not null or v_booking.status in ('CANCELLED', 'REFUNDED') then
    return query select false, 'CANCELLED'::text, 'This booking has been cancelled.'::text, v_booking.expires_at; return;
  end if;
  if v_booking.status in ('PAID', 'CONFIRMED') then
    return query select false, 'ALREADY_PAID'::text, 'This booking is already paid.'::text, v_booking.expires_at; return;
  end if;
  if v_booking.status = 'PAYMENT_PENDING' then
    return query select true, null::text, null::text, v_booking.expires_at; return;
  end if;
  if v_booking.status not in ('UNPAID', 'PAYMENT_FAILED') then
    return query select false, 'NOT_PAYABLE'::text, 'This booking is not awaiting payment.'::text, v_booking.expires_at; return;
  end if;

  v_until := least(now() + make_interval(mins => p_hold_minutes),
                   coalesce(v_booking.created_at, now()) + make_interval(hours => p_max_hold_hours));
  if v_until <= now() then
    return query select false, 'EXPIRED'::text, 'The payment window for this booking has closed.'::text, v_booking.expires_at; return;
  end if;

  if v_booking.status = 'UNPAID' and v_booking.expires_at > now() then
    update public.bookings b set expires_at = greatest(b.expires_at, v_until) where b.id = p_booking_id
    returning b.expires_at into v_until;
    return query select true, null::text, null::text, v_until; return;
  end if;

  select * into v_check from public.reclaim_booking_hold(p_booking_id, false);
  if not v_check.ok then
    return query select false, v_check.reason, v_check.detail, v_booking.expires_at; return;
  end if;
  update public.bookings b
     set status = 'UNPAID',
         expires_at = v_until,
         notes = nullif(btrim(regexp_replace(coalesce(b.notes, ''), '\n?PAYFAST_FAILED', '', 'g'), E'\n '), '')
   where b.id = p_booking_id;
  return query select true, null::text, null::text, v_until;
end;
$$;

-- Move a booking to PAYMENT_PENDING (proof uploaded) or PAID (payment confirmed),
-- reclaiming the hold first if it has lapsed. Optionally records the payment in
-- the same transaction. Returns ok = false with a reason instead of raising, so
-- callers can flag the booking for staff.
create or replace function public.set_booking_payment_status(
  p_booking_id uuid,
  p_status text,
  p_payment_method text default null,
  p_force boolean default false,
  p_payment_amount numeric default null,
  p_payment_reference text default null
) returns table(ok boolean, reason text, detail text, previous_status text, reclaimed boolean)
language plpgsql security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
declare
  v_booking public.bookings%rowtype;
  v_check record;
  v_reclaimed boolean := false;
begin
  if p_status not in ('PAID', 'PAYMENT_PENDING') then raise exception 'Unsupported booking status %', p_status; end if;
  if p_payment_amount is not null and p_payment_amount < 0 then raise exception 'Invalid payment amount'; end if;

  select * into v_booking from public.bookings b where b.id = p_booking_id for no key update;
  if not found then
    return query select false, 'NOT_FOUND'::text, 'Booking not found'::text, null::text, false; return;
  end if;
  if v_booking.deleted_at is not null or v_booking.status in ('CANCELLED', 'REFUNDED') then
    return query select false, 'CANCELLED'::text, 'This booking has been cancelled.'::text, v_booking.status, false; return;
  end if;
  if v_booking.status in ('PAID', 'CONFIRMED') then
    return query select false, 'ALREADY_PAID'::text, 'This booking is already paid.'::text, v_booking.status, false; return;
  end if;
  if p_status = 'PAYMENT_PENDING' and v_booking.status = 'PAYMENT_PENDING' then
    return query select true, null::text, null::text, v_booking.status, false; return;
  end if;

  if not (v_booking.status = 'PAYMENT_PENDING' or (v_booking.status = 'UNPAID' and v_booking.expires_at > now())) then
    select * into v_check from public.reclaim_booking_hold(p_booking_id, p_force);
    if not v_check.ok then
      return query select false, v_check.reason, v_check.detail, v_booking.status, false; return;
    end if;
    v_reclaimed := true;
  end if;

  update public.bookings b
     set status = p_status,
         payment_method = coalesce(p_payment_method, b.payment_method),
         notes = case when p_status = 'PAID'
                      then nullif(btrim(regexp_replace(coalesce(b.notes, ''), '\n?PAYFAST_FAILED', '', 'g'), E'\n '), '')
                      else b.notes end,
         attention_reason = case when p_status = 'PAID' then null else b.attention_reason end,
         attention_at = case when p_status = 'PAID' then null else b.attention_at end
   where b.id = p_booking_id;

  if p_payment_amount is not null then
    insert into public.payments(booking_id, amount, method, status, provider_reference)
    values (p_booking_id, p_payment_amount, coalesce(p_payment_method, v_booking.payment_method, 'OTHER'), 'COMPLETE', p_payment_reference);
  end if;

  return query select true, null::text, null::text, v_booking.status, v_reclaimed;
end;
$$;

-- ── 6. Refund to voucher, with the cancellation fee applied atomically ─────
drop function if exists public.issue_booking_voucher(uuid, uuid);

create or replace function public.issue_booking_voucher(
  p_booking_id uuid,
  p_created_by uuid default null,
  p_deduction_percentage numeric default 0,
  p_reason text default 'cancellation'
) returns table(credit_id uuid, credit_code text, original_amount numeric, customer_email text, customer_name text,
                visit_date date, booking_reference text, paid_amount numeric, deduction_percentage numeric)
language plpgsql security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
declare
  v_booking public.bookings%rowtype;
  v_paid numeric(12,2);
  v_amount numeric(12,2);
  v_pct numeric(5,2) := round(coalesce(p_deduction_percentage, 0), 2);
  v_credit_id uuid;
  v_code text;
  v_customer public.customers%rowtype;
begin
  if v_pct < 0 or v_pct >= 100 then raise exception 'The cancellation fee must be between 0%% and 99%%'; end if;
  if coalesce(p_reason, '') not in ('cancellation', 'closure') then raise exception 'Unknown refund reason'; end if;
  select * into v_booking from public.bookings b where b.id = p_booking_id for update;
  if not found then raise exception 'Booking not found'; end if;
  if v_booking.status not in ('PAID', 'CONFIRMED') then raise exception 'Only paid or confirmed bookings can be refunded'; end if;
  if coalesce(v_booking.voucher_issued, false) then raise exception 'Booking has already been refunded'; end if;
  select coalesce(sum(p.amount), v_booking.total_amount)::numeric(12,2) into v_paid
    from public.payments p where p.booking_id = v_booking.id and p.status = 'COMPLETE';
  if v_paid <= 0 then raise exception 'Booking has no paid amount to refund'; end if;
  v_amount := round(v_paid * (100 - v_pct) / 100, 2);
  if v_amount <= 0 then raise exception 'The cancellation fee leaves nothing to refund'; end if;
  loop
    v_code := 'GRC-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8));
    exit when not exists (select 1 from public.booking_credits bc where bc.credit_code = v_code);
  end loop;
  insert into public.booking_credits(credit_code, original_booking_id, original_amount, remaining_balance, created_by,
                                     paid_amount, deduction_percentage, issue_reason)
    values (v_code, v_booking.id, v_amount, v_amount, p_created_by, v_paid, v_pct, p_reason)
    returning id into v_credit_id;
  update public.bookings b
     set status = 'CANCELLED', voucher_issued = true, refunded_at = now(), voucher_credit_id = v_credit_id, amount_due = 0,
         attention_reason = null, attention_at = null
   where b.id = v_booking.id;
  update public.payments p set status = 'REFUNDED' where p.booking_id = v_booking.id and p.status = 'COMPLETE';
  select * into v_customer from public.customers c where c.id = v_booking.customer_id;
  return query select v_credit_id, v_code, v_amount, v_customer.email, concat_ws(' ', v_customer.first_name, v_customer.last_name),
                      v_booking.visit_date, v_booking.reference, v_paid, v_pct;
end;
$$;

-- ── 7. Soft delete ─────────────────────────────────────────────────────────
-- "Delete" in the admin panel hides the booking and cancels it, keeping its
-- payments, proofs and audit trail. Paid bookings must be refunded instead, and
-- bookings with a proof waiting for review must have the proof handled first.
-- An unpaid booking's voucher amount goes back on the voucher.
create or replace function public.archive_booking(p_booking_id uuid, p_actor uuid, p_reason text)
returns table(ok boolean, reason text, detail text, previous_status text)
language plpgsql security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
declare
  v_booking public.bookings%rowtype;
  v_row record;
begin
  if coalesce(btrim(p_reason), '') = '' then raise exception 'A reason is required to delete a booking'; end if;
  select * into v_booking from public.bookings b where b.id = p_booking_id for no key update;
  if not found then
    return query select false, 'NOT_FOUND'::text, 'Booking not found'::text, null::text; return;
  end if;
  if v_booking.deleted_at is not null then
    return query select false, 'ALREADY_DELETED'::text, 'This booking has already been deleted.'::text, v_booking.status; return;
  end if;
  if v_booking.status in ('PAID', 'CONFIRMED') then
    return query select false, 'PAID'::text, 'Paid bookings cannot be deleted. Use Voucher refund instead.'::text, v_booking.status; return;
  end if;
  if v_booking.status = 'PAYMENT_PENDING' then
    return query select false, 'PROOF_PENDING'::text, 'This booking has a proof of payment waiting for review. Approve or reject the proof first.'::text, v_booking.status; return;
  end if;

  if v_booking.status in ('UNPAID', 'PAYMENT_FAILED') then
    for v_row in
      select cr.id, cr.credit_id, cr.amount_used from public.credit_redemptions cr
       where cr.booking_id = p_booking_id and not cr.released order by cr.credit_id for update
    loop
      update public.booking_credits bc
         set remaining_balance = least(bc.original_amount, bc.remaining_balance + v_row.amount_used),
             status = case when bc.status = 'depleted' then 'active' else bc.status end
       where bc.id = v_row.credit_id;
      update public.credit_redemptions cr set released = true, released_at = now() where cr.id = v_row.id;
    end loop;
  end if;

  update public.bookings b
     set status = case when b.status in ('UNPAID', 'PAYMENT_FAILED') then 'CANCELLED' else b.status end,
         deleted_at = now(), deleted_by = p_actor, delete_reason = left(btrim(p_reason), 300),
         attention_reason = null, attention_at = null
   where b.id = p_booking_id;
  return query select true, null::text, null::text, v_booking.status;
end;
$$;

-- ── 8. Bookings list: hide deleted bookings, add "attention" and "deleted" filters
-- p_status: null (all), 'PAID', 'PENDING', 'CANCELLED', 'FAILED', 'ATTENTION' or 'DELETED'.
drop function if exists public.admin_search_bookings(text, text, date, integer, integer);

create or replace function public.admin_search_bookings(
  p_query text default null,
  p_status text default null,
  p_visit_date date default null,
  p_limit integer default 50,
  p_offset integer default 0
) returns table (
  id uuid, reference text, visit_date date, status text, payment_method text,
  total_amount numeric, people_count integer, voucher_issued boolean, created_at timestamptz,
  first_name text, last_name text, email text, attention_reason text, deleted_at timestamptz, total_count bigint
) language sql stable set search_path = public, pg_temp as $$
  with term as (
    -- Treat % and _ typed by staff as literal characters, not wildcards.
    select '%' || replace(replace(replace(nullif(trim(p_query), ''), '\', '\\'), '%', '\%'), '_', '\_') || '%' as pattern
  ),
  matches as (
    select b.id, b.reference, b.visit_date, b.status, b.payment_method, b.total_amount, b.people_count,
           b.voucher_issued, b.created_at, c.first_name, c.last_name, c.email, b.attention_reason, b.deleted_at
    from public.bookings b
    left join public.customers c on c.id = b.customer_id
    cross join term
    where (p_visit_date is null or b.visit_date = p_visit_date)
      and case p_status
            when 'DELETED' then b.deleted_at is not null
            when 'ATTENTION' then b.attention_reason is not null
            else b.deleted_at is null
          end
      and (p_status is null or p_status in ('DELETED', 'ATTENTION')
        or (p_status = 'PAID' and b.status in ('PAID', 'CONFIRMED'))
        or (p_status = 'PENDING' and b.status in ('UNPAID', 'PAYMENT_PENDING'))
        or (p_status = 'CANCELLED' and b.status in ('CANCELLED', 'REFUNDED'))
        or (p_status = 'FAILED' and b.status = 'PAYMENT_FAILED'))
      and (term.pattern is null
        or b.reference ilike term.pattern
        or c.email ilike term.pattern
        or (c.first_name || ' ' || c.last_name) ilike term.pattern
        or exists (select 1 from public.tickets t where t.booking_id = b.id and t.ticket_uid ilike term.pattern))
  )
  select m.*, count(*) over () as total_count
  from matches m
  order by m.created_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

-- ── 9. Lock down direct API access ─────────────────────────────────────────
-- The anon key ships in every page, and anyone who signs in gets the
-- "authenticated" role. Neither may call these functions or touch these tables
-- directly: every read and write goes through the Next.js server with the
-- service role. (Previously anyone could call issue_booking_voucher,
-- reserve_capacity etc. with the public key, and staff could edit voucher
-- balances directly through the API with their own session.)

-- Policies that let any signed-in user read rows by email. The app never uses
-- customer sign-in, so they only widen access.
drop policy if exists "customers read own credits" on public.booking_credits;
drop policy if exists "customers read own redemptions" on public.credit_redemptions;
drop policy if exists "customers read own booking spots" on public.booking_spots;
drop policy if exists "public can view venue spots" on public.venue_spots;

do $$
declare
  v_fn record;
begin
  for v_fn in
    select format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) as signature,
           p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) = current_user as owned
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind in ('f', 'p')
      and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
  loop
    execute format('revoke all on routine %s from public, anon, authenticated', v_fn.signature);
    execute format('grant execute on routine %s to service_role', v_fn.signature);
    if v_fn.prosecdef and v_fn.owned
       and not exists (select 1 from unnest(coalesce(v_fn.proconfig, '{}'::text[])) setting where setting like 'search_path=%') then
      execute format('alter routine %s set search_path = public, pg_temp', v_fn.signature);
      raise notice 'Pinned search_path on %', v_fn.signature;
    end if;
  end loop;
end $$;

-- Row level security policies still call this for signed-in staff.
grant execute on function public.current_staff_role() to authenticated;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;

-- ── 10. Row level security on every table ─────────────────────────────────
-- customers, bookings, booking_items, payments, packages, huts,
-- business_settings, api_rate_limits and checkin_conflicts were never switched
-- on by a migration, so rebuilding the database from this repository left them
-- readable with the public key.
do $$
declare
  v_table record;
begin
  for v_table in
    select c.oid::regclass as table_name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity
  loop
    execute format('alter table %s enable row level security', v_table.table_name);
    raise notice 'Enabled row level security on %', v_table.table_name;
  end loop;
end $$;

-- ── 11. Release lapsed voucher holds every five minutes ───────────────────
do $$
begin
  create extension if not exists pg_cron with schema pg_catalog;
  perform cron.schedule('release-expired-voucher-holds', '*/5 * * * *', 'select public.release_expired_booking_vouchers()');
exception when others then
  raise notice 'Could not schedule the voucher release job (%). Enable pg_cron under Database > Extensions and run: select cron.schedule(''release-expired-voucher-holds'', ''*/5 * * * *'', ''select public.release_expired_booking_vouchers()'');', sqlerrm;
end $$;

-- Return any voucher balance already stuck on lapsed bookings.
select public.release_expired_booking_vouchers();

commit;

notify pgrst, 'reload schema';
