alter table public.bookings add column if not exists refunded_at timestamptz;
alter table public.bookings add column if not exists voucher_issued boolean not null default false;
alter table public.bookings add column if not exists voucher_credit_id uuid;
alter table public.bookings add column if not exists voucher_amount_used numeric(12,2) not null default 0;
alter table public.bookings add column if not exists amount_due numeric(12,2);

create table if not exists public.booking_credits (
  id uuid primary key default gen_random_uuid(),
  credit_code text not null unique,
  original_booking_id uuid not null references public.bookings(id) on delete restrict,
  original_amount numeric(12,2) not null check (original_amount > 0),
  remaining_balance numeric(12,2) not null check (remaining_balance >= 0 and remaining_balance <= original_amount),
  status text not null default 'active' check (status in ('active', 'depleted', 'void')),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null
);

create table if not exists public.credit_redemptions (
  id uuid primary key default gen_random_uuid(),
  credit_id uuid not null references public.booking_credits(id) on delete restrict,
  booking_id uuid not null references public.bookings(id) on delete restrict,
  amount_used numeric(12,2) not null check (amount_used > 0),
  created_at timestamptz not null default now()
);

create table if not exists public.credit_void_log (
  id uuid primary key default gen_random_uuid(),
  credit_id uuid not null references public.booking_credits(id) on delete restrict,
  voided_by uuid references auth.users(id) on delete set null,
  reason text not null,
  voided_at timestamptz not null default now()
);

create table if not exists public.notification_failures (
  id uuid primary key default gen_random_uuid(),
  notification_type text not null,
  recipient text,
  entity_type text not null,
  entity_id uuid,
  error_message text not null,
  attempts integer not null default 0,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'bookings_voucher_credit_fk') then
    alter table public.bookings add constraint bookings_voucher_credit_fk
      foreign key (voucher_credit_id) references public.booking_credits(id) on delete set null;
  end if;
end $$;

create index if not exists booking_credits_status_idx on public.booking_credits(status);
create index if not exists booking_credits_created_at_idx on public.booking_credits(created_at desc);
create index if not exists credit_redemptions_credit_idx on public.credit_redemptions(credit_id, created_at desc);
create index if not exists credit_redemptions_booking_idx on public.credit_redemptions(booking_id);
create unique index if not exists one_credit_redemption_per_booking
  on public.credit_redemptions(credit_id, booking_id);

alter table public.booking_credits enable row level security;
alter table public.credit_redemptions enable row level security;
alter table public.credit_void_log enable row level security;
alter table public.notification_failures enable row level security;

drop policy if exists "admins manage booking credits" on public.booking_credits;
create policy "admins manage booking credits" on public.booking_credits for all to authenticated
  using (public.current_staff_role() in ('ADMIN', 'MANAGER'))
  with check (public.current_staff_role() in ('ADMIN', 'MANAGER'));
drop policy if exists "customers read own credits" on public.booking_credits;
create policy "customers read own credits" on public.booking_credits for select to authenticated
  using (exists (
    select 1 from public.bookings b join public.customers c on c.id = b.customer_id
    where b.id = original_booking_id and lower(c.email) = lower((select auth.jwt() ->> 'email'))
  ));
drop policy if exists "admins manage credit redemptions" on public.credit_redemptions;
create policy "admins manage credit redemptions" on public.credit_redemptions for all to authenticated
  using (public.current_staff_role() in ('ADMIN', 'MANAGER'))
  with check (public.current_staff_role() in ('ADMIN', 'MANAGER'));
drop policy if exists "customers read own redemptions" on public.credit_redemptions;
create policy "customers read own redemptions" on public.credit_redemptions for select to authenticated
  using (exists (
    select 1 from public.bookings b join public.customers c on c.id = b.customer_id
    where b.id = credit_redemptions.booking_id and lower(c.email) = lower((select auth.jwt() ->> 'email'))
  ));
drop policy if exists "admins manage credit void logs" on public.credit_void_log;
create policy "admins manage credit void logs" on public.credit_void_log for all to authenticated
  using (public.current_staff_role() = 'ADMIN')
  with check (public.current_staff_role() = 'ADMIN');
drop policy if exists "admins manage notification failures" on public.notification_failures;
create policy "admins manage notification failures" on public.notification_failures for all to authenticated
  using (public.current_staff_role() in ('ADMIN', 'MANAGER'))
  with check (public.current_staff_role() in ('ADMIN', 'MANAGER'));

create or replace function public.issue_booking_voucher(p_booking_id uuid, p_created_by uuid default null)
returns table(credit_id uuid, credit_code text, original_amount numeric, customer_email text, customer_name text, visit_date date, booking_reference text)
language plpgsql security definer set search_path = public as $$
declare
  v_booking public.bookings%rowtype;
  v_amount numeric(12,2);
  v_credit_id uuid;
  v_code text;
  v_customer public.customers%rowtype;
begin
  select * into v_booking from public.bookings where id = p_booking_id for update;
  if not found then raise exception 'Booking not found'; end if;
  if v_booking.status not in ('PAID', 'CONFIRMED') then raise exception 'Only paid or confirmed bookings can be refunded'; end if;
  if coalesce(v_booking.voucher_issued, false) then raise exception 'Booking has already been refunded'; end if;
  select coalesce(sum(amount), v_booking.total_amount)::numeric(12,2) into v_amount
    from public.payments where booking_id = v_booking.id and status = 'COMPLETE';
  if v_amount <= 0 then raise exception 'Booking has no paid amount to refund'; end if;
  loop
    v_code := 'GRC-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8));
    exit when not exists (select 1 from public.booking_credits bc where bc.credit_code = v_code);
  end loop;
  insert into public.booking_credits(credit_code, original_booking_id, original_amount, remaining_balance, created_by)
    values (v_code, v_booking.id, v_amount, v_amount, p_created_by) returning id into v_credit_id;
  update public.bookings set status = 'CANCELLED', voucher_issued = true, refunded_at = now(), voucher_credit_id = v_credit_id, amount_due = 0 where id = v_booking.id;
  update public.payments set status = 'REFUNDED' where booking_id = v_booking.id and status = 'COMPLETE';
  select * into v_customer from public.customers where id = v_booking.customer_id;
  return query select v_credit_id, v_code, v_amount, v_customer.email, concat_ws(' ', v_customer.first_name, v_customer.last_name), v_booking.visit_date, v_booking.reference;
end;
$$;
revoke all on function public.issue_booking_voucher(uuid, uuid) from public;
grant execute on function public.issue_booking_voucher(uuid, uuid) to service_role;

create or replace function public.redeem_booking_credit(p_credit_code text, p_booking_id uuid, p_booking_total numeric)
returns table(amount_used numeric, remaining_balance numeric, credit_id uuid)
language plpgsql security definer set search_path = public as $$
declare
  v_credit public.booking_credits%rowtype;
  v_used numeric(12,2);
begin
  select * into v_credit from public.booking_credits where upper(credit_code) = upper(trim(p_credit_code)) for update;
  if not found or v_credit.status <> 'active' or v_credit.remaining_balance <= 0 then raise exception 'That voucher code is invalid or has no remaining balance'; end if;
  if exists (select 1 from public.credit_redemptions where credit_id = v_credit.id and booking_id = p_booking_id) then raise exception 'This voucher has already been applied to this booking'; end if;
  if p_booking_total <= 0 then raise exception 'Booking total must be greater than zero'; end if;
  v_used := least(v_credit.remaining_balance, p_booking_total)::numeric(12,2);
  insert into public.credit_redemptions(credit_id, booking_id, amount_used) values (v_credit.id, p_booking_id, v_used);
  update public.booking_credits set remaining_balance = remaining_balance - v_used, status = case when remaining_balance - v_used <= 0 then 'depleted' else 'active' end where id = v_credit.id returning booking_credits.remaining_balance into v_credit.remaining_balance;
  update public.bookings set voucher_credit_id = v_credit.id, voucher_amount_used = v_used, amount_due = greatest(p_booking_total - v_used, 0) where id = p_booking_id;
  return query select v_used, v_credit.remaining_balance, v_credit.id;
end;
$$;
revoke all on function public.redeem_booking_credit(text, uuid, numeric) from public;
grant execute on function public.redeem_booking_credit(text, uuid, numeric) to service_role;

-- Replace the capacity function with the voucher-aware version while preserving
-- the existing booking API arguments through the final default parameter.
drop function if exists public.reserve_capacity(date, integer, jsonb, text, numeric, text, text);
create or replace function public.reserve_capacity(
  p_visit_date date, p_people_count integer, p_customer jsonb, p_reference text,
  p_total_amount decimal, p_party_slot text default null, p_idempotency_key text default null,
  p_voucher_code text default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_customer_id uuid; v_booking_id uuid; v_current_count integer; v_max_capacity integer;
  v_voucher_used numeric(12,2) := 0; v_amount_due numeric(12,2) := p_total_amount;
  v_credit public.booking_credits%rowtype;
begin
  if p_idempotency_key is not null then
    select id into v_booking_id from public.bookings where idempotency_key = p_idempotency_key limit 1;
    if v_booking_id is not null then return v_booking_id; end if;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('graceland-booking-' || p_visit_date::text, 0));
  if p_party_slot is not null and exists (select 1 from public.bookings where visit_date = p_visit_date and party_slot = p_party_slot and status in ('UNPAID','PAYMENT_PENDING','PAID','CONFIRMED') and (status <> 'UNPAID' or expires_at > now())) then raise exception 'That birthday party time slot has already been booked.'; end if;
  select coalesce(sum(people_count), 0) into v_current_count from public.bookings where visit_date = p_visit_date and status in ('CONFIRMED','PAID','PAYMENT_PENDING','UNPAID') and (status <> 'UNPAID' or expires_at > now());
  select daily_capacity into v_max_capacity from public.business_settings limit 1; if v_max_capacity is null then v_max_capacity := 500; end if;
  if v_current_count + p_people_count > v_max_capacity then raise exception 'Capacity exceeded. Only % spots left.', (v_max_capacity - v_current_count); end if;
  if p_voucher_code is not null and trim(p_voucher_code) <> '' then
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
revoke all on function public.reserve_capacity(date, integer, jsonb, text, numeric, text, text, text) from public;
grant execute on function public.reserve_capacity(date, integer, jsonb, text, numeric, text, text, text) to service_role;
