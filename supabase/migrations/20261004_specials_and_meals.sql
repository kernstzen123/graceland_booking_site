-- 20261004_specials_and_meals.sql
-- Adds the Specials and Free Meal Vouchers features.

begin;

-- ── 1. Tables ──────────────────────────────────────────────────────────────
create table if not exists public.specials (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('discount', 'buy_x_get_y', 'tickets_and_meals')),
  title text not null,
  description text,
  badge_text text,
  paid_tickets jsonb not null default '[]'::jsonb,
  free_tickets jsonb not null default '[]'::jsonb,
  pricing jsonb not null default '{}'::jsonb,
  free_meals integer not null default 0,
  valid_from date,
  valid_to date,
  valid_weekdays jsonb not null default '[1,2,3,4,5,6,7]'::jsonb,
  stock_limit integer,
  max_per_booking integer,
  active boolean not null default true,
  archived_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.special_settings (
  id integer primary key default 1 check (id = 1),
  meal_name text not null default 'Free Meal'
);
insert into public.special_settings (id, meal_name) values (1, 'Free Meal') on conflict do nothing;

create table if not exists public.booking_specials (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  special_id uuid references public.specials(id) on delete set null,
  quantity integer not null check (quantity > 0),
  snapshot jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists public.meal_vouchers (
  id uuid primary key default gen_random_uuid(),
  meal_uid text not null unique,
  qr_token text not null,
  booking_id uuid not null references public.bookings(id) on delete cascade,
  special_id uuid references public.specials(id) on delete set null,
  visit_date date not null,
  status text not null default 'VALID' check (status in ('VALID', 'REDEEMED', 'CANCELLED')),
  redeemed_at timestamptz,
  redeemed_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.meal_redemptions (
  id uuid primary key default gen_random_uuid(),
  meal_uid text not null,
  booking_id uuid references public.bookings(id) on delete set null,
  status text not null,
  result text not null,
  error_message text,
  scanned_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

-- ── 2. Create booking extension ────────────────────────────────────────────
drop function if exists public.create_booking(date, integer, jsonb, text, numeric, text, text, text, jsonb, uuid[], text, text);
drop function if exists public.create_booking(date, integer, jsonb, text, numeric, text, text, text, jsonb, uuid[], text, text, jsonb);

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
  p_privacy_version text default null,
  p_specials jsonb default '[]'::jsonb
) returns table(booking_id uuid, created boolean)
language plpgsql security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
declare
  v_id uuid;
  v_special_item jsonb;
  v_special_id uuid;
  v_special_qty integer;
  v_special_snapshot jsonb;
  v_special_row public.specials%rowtype;
  v_sold integer;
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

  if jsonb_array_length(p_specials) > 0 then
    for v_special_item in select * from jsonb_array_elements(p_specials) loop
      v_special_id := (v_special_item->>'id')::uuid;
      v_special_qty := (v_special_item->>'quantity')::integer;
      v_special_snapshot := v_special_item->'snapshot';

      select * into v_special_row from public.specials where id = v_special_id for update;
      if not found or not v_special_row.active then
        raise exception 'Special % is no longer available', coalesce(v_special_row.title, 'selected');
      end if;

      if v_special_qty > coalesce(v_special_row.max_per_booking, 999999) then
        raise exception 'Cannot book more than % of special %', v_special_row.max_per_booking, v_special_row.title;
      end if;

      if p_visit_date < coalesce(v_special_row.valid_from, '2000-01-01'::date) or p_visit_date > coalesce(v_special_row.valid_to, '2100-01-01'::date) then
        raise exception 'Special % is not valid for the selected date', v_special_row.title;
      end if;
      
      if coalesce(jsonb_array_length(v_special_row.valid_weekdays), 0) > 0 and not (v_special_row.valid_weekdays @> to_jsonb(extract(isodow from p_visit_date)::integer)) then
         raise exception 'Special % is not valid on this day of the week', v_special_row.title;
      end if;

      if v_special_row.stock_limit is not null then
        select coalesce(sum(bs.quantity), 0) into v_sold
        from public.booking_specials bs
        join public.bookings b on b.id = bs.booking_id
        where bs.special_id = v_special_id
          and b.status in ('CONFIRMED', 'PAID', 'PAYMENT_PENDING', 'UNPAID')
          and (b.status <> 'UNPAID' or b.expires_at > now());
          
        if v_sold + v_special_qty > v_special_row.stock_limit then
          raise exception 'Special % is sold out (only % left)', v_special_row.title, greatest(v_special_row.stock_limit - v_sold, 0);
        end if;
      end if;
      
      insert into public.booking_specials (booking_id, special_id, quantity, snapshot)
      values (v_id, v_special_id, v_special_qty, v_special_snapshot);
    end loop;
  end if;

  update public.bookings b
     set terms_version = p_terms_version,
         privacy_version = p_privacy_version,
         terms_accepted_at = case when p_terms_version is not null or p_privacy_version is not null then now() end
   where b.id = v_id;

  return query select v_id, true;
end;
$$;


-- ── 3. Extend reclaim_booking_hold ──────────────────────────────────────────
drop function if exists public.reclaim_booking_hold(uuid, boolean);
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
  v_special_item record;
  v_special_row public.specials%rowtype;
  v_sold integer;
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
           and (ob.status <> 'UNPAID' or ob.expires_at > now())
           and public.spot_hold_window(vs.type, ob.party_slot) && public.spot_hold_window(vs.type, v_booking.party_slot));
    if v_spots is not null then
      return query select false, 'SEAT_TAKEN'::text, format('%s has since been booked by another customer.', v_spots); return;
    end if;

    for v_special_item in select * from public.booking_specials where booking_id = v_booking.id loop
      select * into v_special_row from public.specials where id = v_special_item.special_id for update;
      if v_special_row.stock_limit is not null then
        select coalesce(sum(bs.quantity), 0) into v_sold
        from public.booking_specials bs
        join public.bookings b on b.id = bs.booking_id
        where bs.special_id = v_special_row.id
          and b.id <> v_booking.id
          and b.status in ('CONFIRMED', 'PAID', 'PAYMENT_PENDING', 'UNPAID')
          and (b.status <> 'UNPAID' or b.expires_at > now());
          
        if v_sold + v_special_item.quantity > v_special_row.stock_limit then
          return query select false, 'SPECIAL_SOLD_OUT'::text, format('The special "%s" is sold out.', coalesce(v_special_row.title, 'selected')); return;
        end if;
      end if;
    end loop;
  end if;

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


-- ── 4. Extend cancellation trigger for meals ────────────────────────────────
create or replace function public.invalidate_booking_tickets()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.status in ('CANCELLED', 'REFUNDED') and old.status is distinct from new.status then
    update public.tickets set status = 'CANCELLED' where booking_id = new.id and status = 'VALID';
    update public.meal_vouchers set status = 'CANCELLED' where booking_id = new.id and status = 'VALID';
  end if;
  return new;
end;
$$;


-- ── 5. Meal redemption function ─────────────────────────────────────────────
create or replace function public.redeem_meal_voucher(p_meal_uid text, p_scanned_by uuid)
returns table(ok boolean, meal_uid text, meal_name text, status text, error_message text)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_voucher public.meal_vouchers%rowtype;
  v_today date := (now() at time zone 'Africa/Johannesburg')::date;
  v_meal_name text;
begin
  select meal_name into v_meal_name from public.special_settings where id = 1;

  select * into v_voucher from public.meal_vouchers m where m.meal_uid = p_meal_uid for update;
  if not found then
    insert into public.meal_redemptions(meal_uid, status, result, error_message, scanned_by)
    values (p_meal_uid, 'INVALID', 'NOT_FOUND', 'Voucher not found', p_scanned_by);
    return query select false, p_meal_uid, v_meal_name, 'INVALID'::text, 'Meal voucher not found'::text;
    return;
  end if;

  if v_voucher.status = 'CANCELLED' then
    insert into public.meal_redemptions(meal_uid, booking_id, status, result, error_message, scanned_by)
    values (p_meal_uid, v_voucher.booking_id, 'CANCELLED', 'CANCELLED', 'Voucher cancelled', p_scanned_by);
    return query select false, p_meal_uid, v_meal_name, 'CANCELLED'::text, 'Meal voucher is cancelled'::text;
    return;
  end if;

  if v_voucher.status = 'REDEEMED' then
    insert into public.meal_redemptions(meal_uid, booking_id, status, result, error_message, scanned_by)
    values (p_meal_uid, v_voucher.booking_id, 'REDEEMED', 'ALREADY_REDEEMED', 'Voucher already redeemed', p_scanned_by);
    return query select false, p_meal_uid, v_meal_name, 'REDEEMED'::text, 'Meal already redeemed'::text;
    return;
  end if;

  if v_voucher.visit_date <> v_today then
    insert into public.meal_redemptions(meal_uid, booking_id, status, result, error_message, scanned_by)
    values (p_meal_uid, v_voucher.booking_id, 'VALID', 'WRONG_DATE', 'Valid only on ' || v_voucher.visit_date, p_scanned_by);
    return query select false, p_meal_uid, v_meal_name, 'VALID'::text, format('Valid only on %s', to_char(v_voucher.visit_date, 'FMDD Mon YYYY'));
    return;
  end if;

  update public.meal_vouchers m
     set status = 'REDEEMED', redeemed_at = now(), redeemed_by = p_scanned_by
   where m.id = v_voucher.id;

  insert into public.meal_redemptions(meal_uid, booking_id, status, result, scanned_by)
  values (p_meal_uid, v_voucher.booking_id, 'VALID', 'REDEEMED', p_scanned_by);

  return query select true, p_meal_uid, v_meal_name, 'REDEEMED'::text, null::text;
end;
$$;


-- ── 6. Admin stats functions ────────────────────────────────────────────────
-- Extend admin_day_overview and admin_report_data to include specials and meals.

create or replace function public.admin_day_overview(p_date date)
returns jsonb language sql stable set search_path = public, pg_temp as $$
  with day as (
    select * from public.bookings where visit_date = p_date
  ),
  paid as (
    select * from day where status in ('PAID', 'CONFIRMED')
  ),
  sales as (
    select coalesce(pk.name, h.name, bi.metadata->>'name', 'Other') as name,
           sum(bi.quantity) as units, sum(bi.subtotal) as revenue
    from public.booking_items bi
    join paid p on p.id = bi.booking_id
    left join public.packages pk on pk.id = bi.package_id
    left join public.huts h on h.id = bi.hut_id
    group by 1
  )
  select jsonb_build_object(
    'headcount', (select coalesce(sum(people_count), 0) from paid),
    'revenue', (select coalesce(sum(total_amount), 0) from paid),
    'bookings', (select count(*) from day),
    'breakdown', (select coalesce(jsonb_object_agg(name, jsonb_build_object('units', units, 'revenue', revenue)), '{}'::jsonb) from sales),
    'unscanned', (select count(*) from public.tickets t join paid p on p.id = t.booking_id where t.status = 'VALID'),
    'scanned', (select count(*) from public.tickets t join day d on d.id = t.booking_id where t.status = 'USED'),
    'lastWeekHeadcount', (select coalesce(sum(people_count), 0) from public.bookings where visit_date = p_date - 7 and status in ('PAID', 'CONFIRMED')),
    'pendingProofs', (select count(*) from public.payment_proofs where status = 'PENDING'),
    'capacity', coalesce((select daily_capacity from public.business_settings limit 1), 500),
    'meals', jsonb_build_object(
      'issued', (select count(*) from public.meal_vouchers m join paid p on p.id = m.booking_id where m.visit_date = p_date and m.status <> 'CANCELLED'),
      'redeemed', (select count(*) from public.meal_vouchers m join paid p on p.id = m.booking_id where m.visit_date = p_date and m.status = 'REDEEMED'),
      'unredeemed', (select count(*) from public.meal_vouchers m join paid p on p.id = m.booking_id where m.visit_date = p_date and m.status = 'VALID')
    )
  );
$$;

create or replace function public.admin_report_data(p_from date, p_to date, p_basis text default 'visit')
returns jsonb language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_by_booked boolean := p_basis = 'booked';
  v_days integer := p_to - p_from + 1;
  v_prev_from date := p_from - (p_to - p_from + 1);
  v_from_ts timestamptz := p_from::timestamp at time zone 'Africa/Johannesburg';
  v_to_ts timestamptz := (p_to + 1)::timestamp at time zone 'Africa/Johannesburg';
  v_prev_from_ts timestamptz := (p_from - (p_to - p_from + 1))::timestamp at time zone 'Africa/Johannesburg';
  v_result jsonb;
begin
  with period as (
    select b.* from public.bookings b
    where case when v_by_booked then b.created_at >= v_from_ts and b.created_at < v_to_ts
               else b.visit_date between p_from and p_to end
  ),
  booking_rows as (
    select b.id, b.reference, b.visit_date, b.created_at, b.status, b.payment_method, b.total_amount, b.amount_due,
           b.voucher_amount_used, b.people_count, b.party_slot, b.expires_at, b.voucher_issued,
           c.first_name, c.last_name, c.email, c.phone,
           coalesce(t.issued, 0) as tickets_issued, coalesce(t.used, 0) as tickets_used,
           i.items_summary, coalesce(i.party_children, 0) as party_children, i.party_option, coalesce(i.party_packs, 0) as party_packs,
           (select jsonb_agg(jsonb_build_object('title', bs.snapshot->>'title', 'quantity', bs.quantity)) from public.booking_specials bs where bs.booking_id = b.id) as specials
    from period b
    left join public.customers c on c.id = b.customer_id
    left join lateral (
      select count(*) filter (where status <> 'CANCELLED') as issued, count(*) filter (where status = 'USED') as used
      from public.tickets where booking_id = b.id
    ) t on true
    left join lateral (
      select string_agg(bi.quantity || '× ' || coalesce(bi.metadata->>'name', 'Item'), '; ' order by bi.ctid) -- insertion order, as the items were chosen
               filter (where bi.subtotal > 0 or bi.metadata->>'isPerson' = 'true') as items_summary,
             sum(bi.quantity) filter (where bi.metadata->>'name' like 'Kiddy Party%') as party_children,
             max(bi.metadata->>'name') filter (where bi.metadata->>'name' like 'Kiddy Party%') as party_option,
             sum(bi.quantity) filter (where bi.metadata->>'name' = 'Optional party pack') as party_packs
      from public.booking_items bi where bi.booking_id = b.id
    ) i on true
  ),
  items as (
    select coalesce(bi.metadata->>'name', 'Other') as name, bi.metadata->>'itemId' as item_id,
           coalesce(bi.metadata->>'isPerson', 'false') = 'true' as is_person,
           sum(bi.quantity) as units, sum(bi.subtotal) as revenue, count(distinct bi.booking_id) as bookings
    from public.booking_items bi
    join period b on b.id = bi.booking_id
    where b.status in ('PAID', 'CONFIRMED')
      and coalesce(bi.metadata->>'name', '') <> 'Birthday party child entrance' -- free ticket mirroring the party package line
    group by 1, 2, 3
  ),
  previous as (
    select count(*) as started,
           count(*) filter (where status in ('PAID', 'CONFIRMED')) as paid,
           coalesce(sum(total_amount) filter (where status in ('PAID', 'CONFIRMED')), 0) as revenue,
           coalesce(sum(coalesce(amount_due, total_amount - coalesce(voucher_amount_used, 0))) filter (where status in ('PAID', 'CONFIRMED')), 0) as collected,
           coalesce(sum(people_count) filter (where status in ('PAID', 'CONFIRMED')), 0) as visitors
    from public.bookings
    where case when v_by_booked then created_at >= v_prev_from_ts and created_at < v_from_ts
               else visit_date between v_prev_from and p_from - 1 end
  ),
  returning_emails as (
    select distinct lower(r.email) as email
    from booking_rows r
    where r.status in ('PAID', 'CONFIRMED') and coalesce(r.email, '') <> ''
      and exists (
        select 1 from public.bookings b2
        join public.customers c2 on c2.id = b2.customer_id
        where lower(c2.email) = lower(r.email) and b2.status in ('PAID', 'CONFIRMED')
          and case when v_by_booked then b2.created_at < v_from_ts else b2.visit_date < p_from end
      )
  ),
  specials_stats as (
    select s.id, s.title, s.type,
           coalesce(sum(bs.quantity), 0) as bundles_sold,
           count(distinct bs.booking_id) as bookings,
           coalesce(sum((bs.snapshot->'pricing'->>'price')::numeric * bs.quantity), 0) as revenue,
           coalesce(sum((bs.snapshot->'pricing'->>'discount')::numeric * bs.quantity), 0) as discount_value,
           coalesce(sum(coalesce((bs.snapshot->>'free_tickets_count')::integer, 0) * bs.quantity), 0) as free_tickets,
           count(m.id) as meals_issued,
           count(m.id) filter (where m.status = 'REDEEMED') as meals_redeemed,
           count(m.id) filter (where m.status = 'CANCELLED') as meals_cancelled
    from public.specials s
    left join public.booking_specials bs on bs.special_id = s.id
    left join period b on b.id = bs.booking_id
    left join public.meal_vouchers m on m.booking_id = b.id and m.special_id = s.id
    where b.status in ('PAID', 'CONFIRMED') or b.id is null
    group by s.id, s.title, s.type
    having count(distinct bs.booking_id) > 0
  )
  select jsonb_build_object(
    'bookings', (select coalesce(jsonb_agg(to_jsonb(r) order by r.visit_date, r.created_at), '[]'::jsonb) from booking_rows r),
    'items', (select coalesce(jsonb_agg(to_jsonb(it)), '[]'::jsonb) from items it),
    'previous', (select to_jsonb(p) from previous p),
    'returningEmails', (select coalesce(jsonb_agg(email), '[]'::jsonb) from returning_emails),
    'seating', case when v_by_booked then null else (
      select jsonb_build_object(
        'hutTotal', (select count(*) from public.venue_spots where type = 'hut' and active),
        'tableTotal', (select count(*) from public.venue_spots where type = 'table' and active),
        'hutBooked', count(*) filter (where vs.type = 'hut'),
        'tableBooked', count(*) filter (where vs.type = 'table'))
      from public.booking_spots bs
      join public.bookings b on b.id = bs.booking_id and b.status in ('PAID', 'CONFIRMED')
      join public.venue_spots vs on vs.id = bs.spot_id
      where bs.visit_date between p_from and p_to
    ) end,
    'vouchers', jsonb_build_object(
      'issuedCount', (select count(*) from public.booking_credits where created_at >= v_from_ts and created_at < v_to_ts),
      'issuedValue', (select coalesce(sum(original_amount), 0) from public.booking_credits where created_at >= v_from_ts and created_at < v_to_ts),
      'voidCount', (select count(*) from public.booking_credits where created_at >= v_from_ts and created_at < v_to_ts and status = 'void'),
      'voidValue', (select coalesce(sum(original_amount), 0) from public.booking_credits where created_at >= v_from_ts and created_at < v_to_ts and status = 'void'),
      'redeemedCount', (select count(*) from public.credit_redemptions where created_at >= v_from_ts and created_at < v_to_ts and not coalesce(released, false)),
      'redeemedValue', (select coalesce(sum(amount_used), 0) from public.credit_redemptions where created_at >= v_from_ts and created_at < v_to_ts and not coalesce(released, false)),
      'outstandingCount', (select count(*) from public.booking_credits where status = 'active'),
      'outstandingValue', (select coalesce(sum(remaining_balance), 0) from public.booking_credits where status = 'active')
    ),
    'specials', (select coalesce(jsonb_agg(to_jsonb(ss)), '[]'::jsonb) from specials_stats ss),
    'capacity', coalesce((select daily_capacity from public.business_settings limit 1), 500),
    'days', v_days
  ) into v_result;
  return v_result;
end;
$$;


-- ── 7. Privileges and RLS ───────────────────────────────────────────────────
revoke all on function public.create_booking(date, integer, jsonb, text, numeric, text, text, text, jsonb, uuid[], text, text, jsonb) from public, anon, authenticated;
grant execute on function public.create_booking(date, integer, jsonb, text, numeric, text, text, text, jsonb, uuid[], text, text, jsonb) to service_role;

revoke all on function public.reclaim_booking_hold(uuid, boolean) from public, anon, authenticated;
grant execute on function public.reclaim_booking_hold(uuid, boolean) to service_role;

revoke all on function public.redeem_meal_voucher(text, uuid) from public, anon, authenticated;
grant execute on function public.redeem_meal_voucher(text, uuid) to service_role;

revoke all on function public.admin_day_overview(date) from public, anon, authenticated;
grant execute on function public.admin_day_overview(date) to service_role;

revoke all on function public.admin_report_data(date, date, text) from public, anon, authenticated;
grant execute on function public.admin_report_data(date, date, text) to service_role;

revoke all on all tables in schema public from anon, authenticated;

alter table public.specials enable row level security;
alter table public.special_settings enable row level security;
alter table public.booking_specials enable row level security;
alter table public.meal_vouchers enable row level security;
alter table public.meal_redemptions enable row level security;

commit;

notify pgrst, 'reload schema';
