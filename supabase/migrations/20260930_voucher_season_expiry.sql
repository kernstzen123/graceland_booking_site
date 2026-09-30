-- Vouchers can only be used in the season they were issued in.
--
-- A season runs from 1 September to 30 April. A voucher issued during a season
-- expires on that season's 30 April; one issued in the May–August winter break
-- expires on the following 30 April. After that date it can no longer be
-- applied to a booking, and it can never pay for a visit after that date.
--
-- The rule is enforced where a voucher is applied to a booking (a row in
-- credit_redemptions), so it covers every path: new bookings, and a lapsed
-- booking whose voucher amount is re-applied.
--
-- Safe to run more than once.

create or replace function public.voucher_expiry_date(p_issued timestamptz)
returns date language sql stable set search_path = public, pg_temp as $$
  select make_date(extract(year from issued.day)::int + case when extract(month from issued.day) >= 5 then 1 else 0 end, 4, 30)
    from (select (p_issued at time zone 'Africa/Johannesburg')::date as day) issued;
$$;

create or replace function public.enforce_voucher_season()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_expiry date;
  v_visit date;
begin
  -- Only when a voucher amount is (re)applied: a new redemption, or a released one taken up again.
  if tg_op = 'INSERT' and new.released then return new; end if;
  if tg_op = 'UPDATE' and not (old.released and not new.released) then return new; end if;

  select public.voucher_expiry_date(bc.created_at) into v_expiry from public.booking_credits bc where bc.id = new.credit_id;
  if v_expiry is null then return new; end if;
  if (now() at time zone 'Africa/Johannesburg')::date > v_expiry then
    raise exception 'This voucher has expired. Vouchers can only be used in the season they were issued in.';
  end if;
  select b.visit_date into v_visit from public.bookings b where b.id = new.booking_id;
  if v_visit > v_expiry then
    raise exception 'This voucher can only be used for visits up to %.', to_char(v_expiry, 'FMDD FMMonth YYYY');
  end if;
  return new;
end;
$$;

drop trigger if exists credit_redemptions_voucher_season on public.credit_redemptions;
create trigger credit_redemptions_voucher_season
  before insert or update of released on public.credit_redemptions
  for each row execute function public.enforce_voucher_season();

revoke all on function public.voucher_expiry_date(timestamptz) from public, anon, authenticated;
revoke all on function public.enforce_voucher_season() from public, anon, authenticated;
grant execute on function public.voucher_expiry_date(timestamptz) to service_role;
