-- ============================================================================
-- Clear test data - Graceland Venues
-- Run in Supabase Dashboard -> SQL Editor.
--
-- KEPT (never touched):
--   price_settings, business_settings, packages, huts   (pricing / settings)
--   admin_roles                                          (staff accounts)
--   venue_spots                                          (seating layout)
--   special_settings, closed_dates                       (configuration)
--   auth.users                                           (logins)
--
-- DELETED (all rows): bookings and everything attached to them, customers,
--   tickets + scans, payments + proofs, meal vouchers + redemptions,
--   booking specials, the specials themselves, voucher credits, check-in
--   conflicts, audit log, notification failures, rate limits.
--
-- Safe to re-run. Tables that don't exist in your database are skipped.
-- ============================================================================

begin;

do $$
declare
  t text;
  tables text[] := array[
    -- children first (CASCADE handles the rest)
    'meal_redemptions', 'meal_vouchers', 'booking_specials',
    'ticket_scans', 'tickets', 'checkin_conflicts',
    'payment_proofs', 'payments',
    'credit_redemptions', 'credit_void_log', 'booking_credits',
    'booking_spots', 'booking_items',
    'bookings', 'customers',
    'specials',
    'notification_failures', 'admin_audit_log', 'api_rate_limits'
  ];
begin
  foreach t in array tables loop
    if to_regclass('public.' || t) is not null then
      execute format('truncate table public.%I restart identity cascade', t);
      raise notice 'Cleared %', t;
    else
      raise notice 'Skipped % (does not exist)', t;
    end if;
  end loop;
end $$;

-- Sanity check: kept tables should still have their rows.
select 'price_settings' as table_name, count(*) from public.price_settings
union all select 'business_settings', count(*) from public.business_settings
union all select 'admin_roles', count(*) from public.admin_roles
union all select 'venue_spots', count(*) from public.venue_spots
union all select 'bookings (should be 0)', count(*) from public.bookings
union all select 'tickets (should be 0)', count(*) from public.tickets;

commit;

-- Optional: uploaded proof-of-payment files live in Storage, not SQL.
-- Delete them in Dashboard -> Storage -> (your proofs bucket) -> select all -> Delete.
