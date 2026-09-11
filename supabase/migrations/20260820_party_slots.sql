alter table public.bookings add column if not exists party_slot text;
drop function if exists public.reserve_capacity(date, integer, jsonb, text, numeric);

create or replace function public.reserve_capacity(
  p_visit_date date,
  p_people_count integer,
  p_customer jsonb,
  p_reference text,
  p_total_amount decimal,
  p_party_slot text default null
) returns uuid as $$
declare
  v_customer_id uuid;
  v_booking_id uuid;
  v_current_count integer;
  v_max_capacity integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('graceland-booking-' || p_visit_date::text, 0));
  if p_party_slot is not null and exists (
    select 1 from public.bookings
    where visit_date = p_visit_date and party_slot = p_party_slot
      and status in ('UNPAID', 'PAYMENT_PENDING', 'PAID', 'CONFIRMED')
      and (status != 'UNPAID' or expires_at > now())
  ) then
    raise exception 'That birthday party time slot has already been booked.';
  end if;

  select coalesce(sum(people_count), 0) into v_current_count
  from public.bookings
  where visit_date = p_visit_date
    and status in ('CONFIRMED', 'PAID', 'PAYMENT_PENDING', 'UNPAID')
    and (status != 'UNPAID' or expires_at > now());
  select daily_capacity into v_max_capacity from public.business_settings limit 1;
  if v_max_capacity is null then v_max_capacity := 500; end if;
  if (v_current_count + p_people_count) > v_max_capacity then
    raise exception 'Capacity exceeded. Only % spots left.', (v_max_capacity - v_current_count);
  end if;

  insert into public.customers (first_name, last_name, email, phone)
  values (p_customer->>'firstName', p_customer->>'lastName', p_customer->>'email', p_customer->>'phone')
  returning id into v_customer_id;
  insert into public.bookings (reference, customer_id, visit_date, status, total_amount, people_count, expires_at, party_slot)
  values (p_reference, v_customer_id, p_visit_date, 'UNPAID', p_total_amount, p_people_count, now() + interval '15 minutes', p_party_slot)
  returning id into v_booking_id;
  return v_booking_id;
end;
$$ language plpgsql;
