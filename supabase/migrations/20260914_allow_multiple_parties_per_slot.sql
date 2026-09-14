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
  
  -- The previous check for 1-party-per-slot has been removed.
  -- Multiple parties can now share a time slot as long as they book different huts.
  -- Hut overlap protection is handled in reserve_booking_spots.
  
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
