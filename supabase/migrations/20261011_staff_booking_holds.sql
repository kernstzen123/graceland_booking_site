-- 20261011_staff_booking_holds.sql
--
-- Bookings staff make on the Add booking tab without payment (payment_method
-- MANUAL_EFT, sold_by set) are no longer on the 48-hour payment window that
-- online bookings have: they keep their places until the end of the visit day
-- (South African time). New bookings get this from the app; this updates the
-- staff bookings that are waiting for payment right now.
--
-- Only bookings that still hold their places are changed (their hold is made
-- longer), so nothing goes over capacity or takes a seat from someone else.
-- Bookings whose hold already ran out are left alone: see
-- supabase/revive_lapsed_office_bookings.sql to bring those back.
--
-- Safe to run more than once. Apply after 20261010_imported_booking_payments.sql.

begin;

update public.bookings b
   set expires_at = ((b.visit_date + 1)::timestamp at time zone 'Africa/Johannesburg') - interval '1 second'
 where b.status = 'UNPAID'
   and b.deleted_at is null
   and (b.sold_by is not null or b.payment_method = 'MANUAL_EFT')
   and b.expires_at > now()
   and b.expires_at < ((b.visit_date + 1)::timestamp at time zone 'Africa/Johannesburg') - interval '1 second';

commit;
