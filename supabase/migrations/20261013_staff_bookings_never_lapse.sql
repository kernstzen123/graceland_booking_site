-- 20261013_staff_bookings_never_lapse.sql
--
-- Unpaid bookings staff make on the Add booking tab (payment_method MANUAL_EFT,
-- or sold_by set) no longer lapse at all: they keep their places until they
-- are paid or an admin or manager deletes them. Only online bookings have a
-- payment window. The app stores this as a hold until 9999-12-31; this gives
-- the same hold to the staff bookings that are waiting for payment now.
--
-- 1. Staff bookings that still hold their places (including ones held until the
--    end of their visit day by 20261011_staff_booking_holds.sql).
-- 2. Staff bookings whose visit date has passed and whose hold already ran out:
--    they get their places back for that past date, which no one else can book
--    any more, so nothing goes over capacity or loses a seat.
--
-- Unpaid staff bookings for today or later whose hold already ran out are left
-- alone here, because someone else may have their places now: run
-- supabase/revive_lapsed_office_bookings.sql to bring those back safely.
--
-- Safe to run more than once. Apply after 20261012_special_auto_apply.sql
-- (20261011_staff_booking_holds.sql does not need to be run first).

begin;

update public.bookings b
   set expires_at = timestamptz '9999-12-31 23:59:59+00'
 where b.status = 'UNPAID'
   and b.deleted_at is null
   and (b.sold_by is not null or b.payment_method = 'MANUAL_EFT')
   and b.expires_at is distinct from timestamptz '9999-12-31 23:59:59+00'
   and (b.expires_at > now()
        or b.visit_date < (now() at time zone 'Africa/Johannesburg')::date);

commit;
