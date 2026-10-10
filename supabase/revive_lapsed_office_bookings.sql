-- revive_lapsed_office_bookings.sql (optional, run by hand in the Supabase SQL editor)
--
-- Unpaid bookings staff made on the Add booking tab used to lose their places
-- after 48 hours. This brings back the ones for today or later, with their
-- places held until the end of the visit day, but only when the day still has
-- room, their huts/tables are still free, any special is not sold out and any
-- voucher still covers them (the same checks as when a late payment arrives,
-- via public.reclaim_booking_hold). Each booking is reported in the output:
-- "revived" or "not revived" with the reason. Deleted bookings are skipped.
--
-- Run 20261011_staff_booking_holds.sql first.

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
         set expires_at = ((b.visit_date + 1)::timestamp at time zone 'Africa/Johannesburg') - interval '1 second',
             payment_failed_at = null
       where b.id = v_booking.id;
      raise notice 'revived % (%)', v_booking.reference, v_booking.visit_date;
    else
      raise notice 'not revived % (%): %', v_booking.reference, v_booking.visit_date, v_check.detail;
    end if;
  end loop;
end;
$$;
