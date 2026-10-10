-- revive_lapsed_office_bookings.sql (optional, run by hand in the Supabase SQL editor)
--
-- Unpaid bookings staff made on the Add booking tab used to lose their places
-- when their hold ran out. This brings back the ones for today or later, so
-- they keep their places until they are paid or an admin or manager deletes
-- them, but only when the day still has room, their huts/tables are still
-- free, any special is not sold out and any voucher still covers them (the
-- same checks as when a late payment arrives, via public.reclaim_booking_hold).
-- The result table lists every booking as "revived" or "not revived" with the
-- reason. Deleted bookings are skipped. Running it again is harmless.
--
-- Run supabase/migrations/20261013_staff_bookings_never_lapse.sql first.

create temp table if not exists revive_results (reference text, visit_date date, result text);
truncate revive_results;

do $$
declare
  v_booking record;
  v_check record;
  v_today date := (now() at time zone 'Africa/Johannesburg')::date;
begin
  for v_booking in
    select b.id, b.reference, b.visit_date
      from public.bookings b
     where b.status = 'UNPAID'
       and b.deleted_at is null
       and (b.sold_by is not null or b.payment_method = 'MANUAL_EFT')
       and (b.expires_at is null or b.expires_at <= now())
       and b.visit_date >= v_today
     order by b.created_at
  loop
    select * into v_check from public.reclaim_booking_hold(v_booking.id, false);
    if v_check.ok then
      update public.bookings b
         set expires_at = timestamptz '9999-12-31 23:59:59+00',
             payment_failed_at = null
       where b.id = v_booking.id;
      insert into revive_results values (v_booking.reference, v_booking.visit_date, 'revived');
    else
      insert into revive_results values (v_booking.reference, v_booking.visit_date, 'not revived: ' || coalesce(v_check.detail, v_check.reason));
    end if;
  end loop;
end;
$$;

select * from revive_results order by visit_date, reference;
