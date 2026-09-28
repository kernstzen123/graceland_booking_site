-- Production hardening, part 2.
--
-- Apply BEFORE deploying the matching application code (it is safe while the
-- current code is still live). Running it twice is harmless.
--
--   1. Longer, unguessable voucher codes (GRC-XXXX-XXXX-XXXX). Existing codes keep working.
--   2. Bookings are created in one transaction (booking, items, seating and
--      voucher together), so a failure can no longer leave half a booking
--      holding places for 15 minutes.
--   3. Ticket emails are claimed before sending, so two simultaneous PayFast
--      notifications cannot email the tickets twice. Payment state moves out of
--      the free-text notes into columns.
--   4. The customer's acceptance of the terms and privacy policy is stored with
--      the versions they accepted.
--   5. Business settings (daily capacity, support email and phone) get a single
--      row that admins edit from the Prices & dates page.
--   6. Old rate-limit rows are cleaned up daily.

begin;

-- ── 1. Voucher codes ────────────────────────────────────────────────────────
-- 12 characters from a 32-letter alphabet without 0/O/1/I (60 bits of
-- randomness), from gen_random_uuid(), which is cryptographically random.
create or replace function public.generate_voucher_code()
returns text
language plpgsql volatile set search_path = public, pg_temp as $$
declare
  v_alphabet constant text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  v_positions constant integer[] := array[0, 1, 2, 3, 4, 5, 7, 9, 10, 11, 12, 13]; -- skip the uuid version/variant bytes
  v_bytes bytea;
  v_chars text := '';
  v_code text;
begin
  loop
    v_bytes := uuid_send(gen_random_uuid());
    v_chars := '';
    for i in 1..12 loop
      v_chars := v_chars || substr(v_alphabet, (get_byte(v_bytes, v_positions[i]) & 31) + 1, 1);
    end loop;
    v_code := 'GRC-' || substr(v_chars, 1, 4) || '-' || substr(v_chars, 5, 4) || '-' || substr(v_chars, 9, 4);
    exit when not exists (select 1 from public.booking_credits bc where bc.credit_code = v_code);
  end loop;
  return v_code;
end;
$$;

-- issue_booking_voucher: unchanged from 20260927, except for the new code format.
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
  v_code := public.generate_voucher_code();
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

-- ── 3. Payment and ticket-email state as columns ───────────────────────────
alter table public.bookings add column if not exists tickets_emailed_at timestamptz;
alter table public.bookings add column if not exists ticket_email_claimed_at timestamptz;
alter table public.bookings add column if not exists payment_failed_at timestamptz;

update public.bookings set tickets_emailed_at = coalesce(created_at, now())
 where tickets_emailed_at is null and notes like '%TICKETS_EMAIL_SENT%';
update public.bookings set payment_failed_at = now()
 where payment_failed_at is null and notes like '%PAYFAST_FAILED%'
   and status in ('UNPAID', 'PAYMENT_PENDING', 'PAYMENT_FAILED');

-- Returns CLAIMED (this caller must send the tickets email), ALREADY_SENT,
-- IN_PROGRESS (someone else claimed it in the last p_stale_minutes) or NOT_FOUND.
create or replace function public.claim_ticket_email(p_booking_id uuid, p_stale_minutes integer default 10)
returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_booking public.bookings%rowtype;
begin
  select * into v_booking from public.bookings b where b.id = p_booking_id for no key update;
  if not found then return 'NOT_FOUND'; end if;
  if v_booking.tickets_emailed_at is not null then return 'ALREADY_SENT'; end if;
  if v_booking.ticket_email_claimed_at is not null
     and v_booking.ticket_email_claimed_at > now() - make_interval(mins => greatest(p_stale_minutes, 1)) then
    return 'IN_PROGRESS';
  end if;
  update public.bookings b set ticket_email_claimed_at = now() where b.id = p_booking_id;
  return 'CLAIMED';
end;
$$;

-- Record the outcome of a claimed send: sent (tickets_emailed_at) or failed (claim released).
create or replace function public.finish_ticket_email(p_booking_id uuid, p_sent boolean)
returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.bookings b
     set tickets_emailed_at = case when p_sent then coalesce(b.tickets_emailed_at, now()) else b.tickets_emailed_at end,
         ticket_email_claimed_at = null
   where b.id = p_booking_id;
$$;

-- hold_booking_for_payment / set_booking_payment_status: unchanged from
-- 20260927, except that they also clear payment_failed_at.
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
    update public.bookings b set expires_at = greatest(b.expires_at, v_until), payment_failed_at = null where b.id = p_booking_id
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
         payment_failed_at = null,
         notes = nullif(btrim(regexp_replace(coalesce(b.notes, ''), '\n?PAYFAST_FAILED', '', 'g'), E'\n '), '')
   where b.id = p_booking_id;
  return query select true, null::text, null::text, v_until;
end;
$$;

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
         payment_failed_at = case when p_status = 'PAID' then null else b.payment_failed_at end,
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

-- ── 4. Consent record ──────────────────────────────────────────────────────
alter table public.bookings add column if not exists terms_version text;
alter table public.bookings add column if not exists privacy_version text;
alter table public.bookings add column if not exists terms_accepted_at timestamptz;

-- ── 2. Create a booking in one transaction ─────────────────────────────────
-- Capacity, voucher, customer, booking, items and seating either all succeed
-- or none of it is saved. With an idempotency key that was already used, the
-- existing booking is returned (created = false) and nothing new is saved.
create or replace function public.create_booking(
  p_visit_date date,
  p_people_count integer,
  p_customer jsonb,
  p_reference text,
  p_total_amount numeric,
  p_party_slot text,
  p_idempotency_key text,
  p_voucher_code text,
  p_items jsonb,
  p_spot_ids uuid[] default '{}',
  p_terms_version text default null,
  p_privacy_version text default null
) returns table(booking_id uuid, created boolean)
language plpgsql security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
declare
  v_id uuid;
begin
  if p_idempotency_key is not null then
    select b.id into v_id from public.bookings b where b.idempotency_key = p_idempotency_key;
    if v_id is not null then
      return query select v_id, false; return;
    end if;
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'At least one booking item is required';
  end if;

  v_id := public.reserve_capacity(p_visit_date, p_people_count, p_customer, p_reference, p_total_amount,
                                  p_party_slot, p_idempotency_key, p_voucher_code);

  insert into public.booking_items(booking_id, quantity, price_per_unit, subtotal, metadata)
  select v_id, (item->>'quantity')::integer, (item->>'price_per_unit')::numeric, (item->>'subtotal')::numeric,
         coalesce(item->'metadata', '{}'::jsonb)
    from jsonb_array_elements(p_items) item;

  if coalesce(array_length(p_spot_ids, 1), 0) > 0 then
    perform public.reserve_booking_spots(v_id, p_visit_date, p_spot_ids);
  end if;

  update public.bookings b
     set terms_version = p_terms_version,
         privacy_version = p_privacy_version,
         terms_accepted_at = case when p_terms_version is not null or p_privacy_version is not null then now() end
   where b.id = v_id;

  return query select v_id, true;
end;
$$;

-- ── 5. Business settings ───────────────────────────────────────────────────
alter table public.business_settings add column if not exists support_email text;
alter table public.business_settings add column if not exists support_phone text;
alter table public.business_settings add column if not exists updated_by uuid references auth.users(id) on delete set null;

insert into public.business_settings(business_name, daily_capacity, buffer_capacity, support_email, support_phone)
select 'Graceland Venues', 500, 5, 'support@graceland-venues.co.za', '072 264 4009'
where not exists (select 1 from public.business_settings);
update public.business_settings
   set support_email = coalesce(support_email, 'support@graceland-venues.co.za'),
       support_phone = coalesce(support_phone, '072 264 4009');

-- The app reads "the" settings row: only ever allow one.
create unique index if not exists business_settings_single_row on public.business_settings ((true));
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'business_settings_capacity_range') then
    alter table public.business_settings add constraint business_settings_capacity_range check (daily_capacity between 1 and 5000);
  end if;
end $$;

-- ── Privileges for the new functions (server only) ────────────────────────
revoke all on function public.generate_voucher_code() from public, anon, authenticated;
revoke all on function public.claim_ticket_email(uuid, integer) from public, anon, authenticated;
revoke all on function public.finish_ticket_email(uuid, boolean) from public, anon, authenticated;
revoke all on function public.create_booking(date, integer, jsonb, text, numeric, text, text, text, jsonb, uuid[], text, text) from public, anon, authenticated;
grant execute on function public.generate_voucher_code() to service_role;
grant execute on function public.claim_ticket_email(uuid, integer) to service_role;
grant execute on function public.finish_ticket_email(uuid, boolean) to service_role;
grant execute on function public.create_booking(date, integer, jsonb, text, numeric, text, text, text, jsonb, uuid[], text, text) to service_role;

-- ── 6. Clean up old rate-limit rows daily ─────────────────────────────────
do $$
begin
  perform cron.schedule('prune-api-rate-limits', '17 3 * * *', 'delete from public.api_rate_limits where window_started < now() - interval ''2 days''');
exception when others then
  raise notice 'Could not schedule the rate-limit cleanup (%). Enable pg_cron under Database > Extensions and run: select cron.schedule(''prune-api-rate-limits'', ''17 3 * * *'', ''delete from public.api_rate_limits where window_started < now() - interval ''''2 days'''''');', sqlerrm;
end $$;

commit;

notify pgrst, 'reload schema';
