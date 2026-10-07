-- 20261007_specials_server_pricing_and_daily_stock.sql
--
-- Fixes three problems with specials:
--
-- 1. create_booking saved the copy of the special sent by the customer's browser
--    (price, paid/free tickets, free meals). Tickets and meal vouchers are issued
--    from that copy, so it is now built from the specials table instead, and an
--    archived special or a quantity below 1 is refused.
-- 2. The admin page stores weekdays as 0 = Sunday … 6 = Saturday, but the check
--    used ISO numbering (Sunday = 7), so Sunday bookings of a special were
--    refused. Both 0 and 7 are now accepted as Sunday.
-- 3. The "Daily Stock Limit" was counted across all dates. It is now counted per
--    visit date, in create_booking and when a lapsed booking is revived.
--
-- Safe to run more than once.

begin;

-- included_meals already exists in the live database (added outside the
-- migrations); this keeps a fresh database in line with it.
alter table public.specials add column if not exists included_meals jsonb not null default '[]'::jsonb;

-- Weekday check shared by create_booking. Empty list = every day.
create or replace function public.special_valid_on_weekday(p_weekdays jsonb, p_date date)
returns boolean language sql immutable set search_path = public, pg_temp as $$
  select coalesce(jsonb_array_length(p_weekdays), 0) = 0
      or p_weekdays @> to_jsonb(extract(dow from p_date)::integer)
      or (extract(dow from p_date) = 0 and p_weekdays @> '7'::jsonb);
$$;
revoke all on function public.special_valid_on_weekday(jsonb, date) from public, anon, authenticated;
grant execute on function public.special_valid_on_weekday(jsonb, date) to service_role;

-- New specials default to "every day" in the same numbering the admin page uses.
alter table public.specials alter column valid_weekdays set default '[]'::jsonb;

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

      select * into v_special_row from public.specials where id = v_special_id for update;
      if v_special_qty is null or v_special_qty < 1 then
        raise exception 'Invalid special quantity';
      end if;

      if not found or not v_special_row.active or v_special_row.archived_at is not null then
        raise exception 'Special % is no longer available', coalesce(v_special_row.title, 'selected');
      end if;

      if v_special_qty > coalesce(v_special_row.max_per_booking, 999999) then
        raise exception 'Cannot book more than % of special %', v_special_row.max_per_booking, v_special_row.title;
      end if;

      if p_visit_date < coalesce(v_special_row.valid_from, '2000-01-01'::date) or p_visit_date > coalesce(v_special_row.valid_to, '2100-01-01'::date) then
        raise exception 'Special % is not valid for the selected date', v_special_row.title;
      end if;
      
      if not public.special_valid_on_weekday(v_special_row.valid_weekdays, p_visit_date) then
         raise exception 'Special % is not valid on this day of the week', v_special_row.title;
      end if;

      if v_special_row.stock_limit is not null then
        select coalesce(sum(bs.quantity), 0) into v_sold
        from public.booking_specials bs
        join public.bookings b on b.id = bs.booking_id
        where bs.special_id = v_special_id
          and b.visit_date = p_visit_date
          and b.status in ('CONFIRMED', 'PAID', 'PAYMENT_PENDING', 'UNPAID')
          and (b.status <> 'UNPAID' or b.expires_at > now());
          
        if v_sold + v_special_qty > v_special_row.stock_limit then
          raise exception 'Special % is sold out (only % left)', v_special_row.title, greatest(v_special_row.stock_limit - v_sold, 0);
        end if;
      end if;
      
      v_special_snapshot := jsonb_build_object(
        'title', v_special_row.title,
        'badge_text', v_special_row.badge_text,
        'type', v_special_row.type,
        'paid_tickets', v_special_row.paid_tickets,
        'free_tickets', v_special_row.free_tickets,
        'pricing', v_special_row.pricing,
        'free_meals', v_special_row.free_meals,
        'included_meals', coalesce(v_special_row.included_meals, '[]'::jsonb));
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
          and b.visit_date = v_booking.visit_date
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

revoke all on function public.create_booking(date, integer, jsonb, text, numeric, text, text, text, jsonb, uuid[], text, text, jsonb) from public, anon, authenticated;
grant execute on function public.create_booking(date, integer, jsonb, text, numeric, text, text, text, jsonb, uuid[], text, text, jsonb) to service_role;
revoke all on function public.reclaim_booking_hold(uuid, boolean) from public, anon, authenticated;
grant execute on function public.reclaim_booking_hold(uuid, boolean) to service_role;

commit;

notify pgrst, 'reload schema';
