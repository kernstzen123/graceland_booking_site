-- 20261016_expire_online_unpaid_bookings.sql
--
-- Online bookings that are still unpaid 48 hours after they were made are
-- deleted automatically (a soft delete, exactly like the Delete button: the
-- booking is cancelled and hidden, any voucher balance it used is given back,
-- and it stays under the "Deleted" filter with its history).
--
-- Only bookings customers made online are touched. Never deleted:
--   * bookings staff added (Add booking tab, walk-ins, imports): sold_by is
--     set, or payment_method is MANUAL_EFT / IMPORTED, or the reference starts IM-
--   * paid bookings, and bookings with a proof of payment waiting for review
--   * bookings with any payment on them (a deposit, a late PayFast payment)
--   * bookings on the "Needs attention" list, or refunded with a voucher
--   * bookings still holding their places (their payment window has not ended
--     at least 30 minutes ago, so a PayFast payment in progress can still land)
--
-- The website calls this whenever staff open the bookings list or the daily
-- summary. If the pg_cron extension is enabled (Supabase: Database →
-- Extensions → pg_cron), it also runs every 15 minutes on its own.
--
-- Safe to run more than once. Apply after 20261015_tables_t1_t8_positions.sql.

begin;

create or replace function public.expire_online_unpaid_bookings()
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_booking record;
  v_result record;
  v_count integer := 0;
begin
  for v_booking in
    select b.id, b.reference, b.status, b.created_at
      from public.bookings b
     where b.deleted_at is null
       and b.status in ('UNPAID', 'PAYMENT_FAILED')
       and b.sold_by is null
       and coalesce(b.payment_method, '') not in ('MANUAL_EFT', 'IMPORTED')
       and coalesce(b.reference, '') not ilike 'IM-%'
       and b.created_at < now() - interval '48 hours'
       and (b.expires_at is null or b.expires_at < now() - interval '30 minutes')
       and b.attention_reason is null
       and not coalesce(b.voucher_issued, false)
       and not exists (select 1 from public.payments p where p.booking_id = b.id and p.status <> 'VOID')
       and not exists (select 1 from public.payment_proofs pp where pp.booking_id = b.id and pp.status = 'PENDING')
     order by b.created_at
     limit 500
     for update of b skip locked
  loop
    select * into v_result
      from public.archive_booking(v_booking.id, null, 'Online booking not paid within 48 hours (deleted automatically)');
    if v_result.ok then
      v_count := v_count + 1;
      insert into public.admin_audit_log(actor_id, actor_email, action, entity_type, entity_id, details)
      values (null, 'system', 'AUTO_DELETE_UNPAID_BOOKING', 'booking', v_booking.id::text,
              jsonb_build_object('reference', v_booking.reference, 'previous_status', v_booking.status, 'created_at', v_booking.created_at));
    end if;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.expire_online_unpaid_bookings() from public, anon, authenticated;
grant execute on function public.expire_online_unpaid_bookings() to service_role;

-- Run it every 15 minutes when pg_cron is available (skipped quietly when it is not).
do $do$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(j.jobid) from cron.job j where j.jobname = 'expire-online-unpaid-bookings';
    perform cron.schedule('expire-online-unpaid-bookings', '*/15 * * * *', 'select public.expire_online_unpaid_bookings()');
  end if;
end
$do$;

commit;

-- Check: online unpaid bookings that will be deleted the next time it runs.
select b.reference, b.status, b.created_at, b.expires_at
  from public.bookings b
 where b.deleted_at is null
   and b.status in ('UNPAID', 'PAYMENT_FAILED')
   and b.sold_by is null
   and coalesce(b.payment_method, '') not in ('MANUAL_EFT', 'IMPORTED')
   and coalesce(b.reference, '') not ilike 'IM-%'
   and b.created_at < now() - interval '48 hours'
   and (b.expires_at is null or b.expires_at < now() - interval '30 minutes')
   and b.attention_reason is null
   and not coalesce(b.voucher_issued, false)
   and not exists (select 1 from public.payments p where p.booking_id = b.id and p.status <> 'VOID')
   and not exists (select 1 from public.payment_proofs pp where pp.booking_id = b.id and pp.status = 'PENDING')
 order by b.created_at;
