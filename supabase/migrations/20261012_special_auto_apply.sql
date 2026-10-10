-- 20261012_special_auto_apply.sql
--
-- A special can be given free to online bookings whose cart total is over a
-- set amount (e.g. R660): the booking gets the special's free entrance tickets
-- and meal vouchers at R0, on dates the special is valid. Staff switch it on
-- per special in Admin > Specials; empty (null) means off, which is how every
-- existing special starts.
--
-- Safe to run more than once. Apply after 20261011_staff_booking_holds.sql.

alter table public.specials add column if not exists auto_apply_min_spend numeric(10,2);

do $$
begin
  alter table public.specials add constraint specials_auto_apply_min_spend_check
    check (auto_apply_min_spend is null or auto_apply_min_spend >= 0);
exception when duplicate_object then null;
end;
$$;

notify pgrst, 'reload schema';
