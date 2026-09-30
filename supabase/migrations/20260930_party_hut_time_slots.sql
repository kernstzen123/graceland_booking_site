-- Birthday-party huts are booked by time of day instead of for the whole day.
--
-- A party holds its hut only for its time slot plus 15 minutes either side to
-- set up and clear it (09:30–11:30 holds 09:15–11:45). Day visitors hold a spot
-- for the whole day, and shaded tables (which cannot host parties) are always
-- booked for the whole day. Two bookings may share a spot on the same day when
-- these windows do not overlap, so one hut can host the 09:30, 12:00 and 14:30
-- parties back to back. The website applies the same rule (spotHoldWindow in
-- src/lib/seating.ts).
--
-- Existing bookings need no changes: the window comes from the booking's party
-- slot and the spot type. Safe to run more than once.

-- Minutes after midnight that a booking holds a spot, as a half-open range.
create or replace function public.spot_hold_window(p_spot_type text, p_party_slot text)
returns int4range language sql immutable set search_path = public, pg_temp as $$
  select case
    when p_spot_type = 'hut' and parsed.m is not null
      then int4range(parsed.m[1]::int * 60 + parsed.m[2]::int - 15, parsed.m[3]::int * 60 + parsed.m[4]::int + 15)
    else int4range(0, 1440)
  end
  from (select regexp_match(coalesce(p_party_slot, ''), '^\s*(\d{1,2}):(\d{2})\s*[–-]\s*(\d{1,2}):(\d{2})\s*$') as m) parsed;
$$;

create or replace function public.reserve_booking_spots(p_booking_id uuid, p_visit_date date, p_spot_ids uuid[])
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_existing_count integer;
  v_requested_count integer := coalesce(array_length(p_spot_ids, 1), 0);
  v_duplicate_count integer;
  v_party_slot text;
begin
  if v_requested_count = 0 then return; end if;
  perform pg_advisory_xact_lock(hashtextextended('graceland-seating-' || p_visit_date::text, 0));
  select count(*) into v_duplicate_count from (select distinct unnest(p_spot_ids)) spots;
  if v_duplicate_count <> v_requested_count then raise exception 'A seating spot was selected more than once'; end if;
  if (select count(*) from public.venue_spots vs where vs.id = any(p_spot_ids) and vs.active) <> v_requested_count then
    raise exception 'One of the selected seating spots is invalid.';
  end if;
  select b.party_slot into v_party_slot from public.bookings b where b.id = p_booking_id;
  -- A spot is taken only by a booking that holds it at the same time of day
  -- (a party for its slot plus set-up and clean-up; anyone else all day).
  if exists (
    select 1 from public.booking_spots bs
      join public.bookings b on b.id = bs.booking_id
      join public.venue_spots vs on vs.id = bs.spot_id
     where bs.visit_date = p_visit_date and bs.spot_id = any(p_spot_ids) and bs.booking_id <> p_booking_id
       and b.status in ('UNPAID','PAYMENT_PENDING','PAID','CONFIRMED') and (b.status <> 'UNPAID' or b.expires_at > now())
       and public.spot_hold_window(vs.type, b.party_slot) && public.spot_hold_window(vs.type, v_party_slot)) then
    raise exception 'This seating spot was just taken. Please choose another spot.';
  end if;
  select count(*) into v_existing_count from public.booking_spots where booking_id = p_booking_id;
  if v_existing_count > 0 then delete from public.booking_spots where booking_id = p_booking_id; end if;
  insert into public.booking_spots(booking_id, spot_id, visit_date) select p_booking_id, spot_id, p_visit_date from unnest(p_spot_ids) spot_id;
end;
$$;

-- Reviving a lapsed booking (a late payment or proof) re-checks its seating with the same time rule.
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
           and (ob.status <> 'UNPAID' or ob.expires_at > now())
           -- Only a booking holding the spot at the same time of day clashes.
           and public.spot_hold_window(vs.type, ob.party_slot) && public.spot_hold_window(vs.type, v_booking.party_slot));
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

revoke all on function public.spot_hold_window(text, text) from public, anon, authenticated;
grant execute on function public.spot_hold_window(text, text) to service_role;
revoke all on function public.reserve_booking_spots(uuid, date, uuid[]) from public, anon, authenticated;
grant execute on function public.reserve_booking_spots(uuid, date, uuid[]) to service_role;
revoke all on function public.reclaim_booking_hold(uuid, boolean) from public, anon, authenticated;
grant execute on function public.reclaim_booking_hold(uuid, boolean) to service_role;
