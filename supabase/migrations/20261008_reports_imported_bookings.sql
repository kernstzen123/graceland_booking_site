-- 20261008_reports_imported_bookings.sql
--
-- Bookings imported from the paper booking book in reports:
-- - reports by booking date leave them out: they were created on the day they
--   were copied in, not when the customer booked (reports by visit date keep them);
-- - the previous period's "cash collected" excludes them, as the report does for
--   the current period: they were paid before the system.
--
-- Safe to run more than once.

begin;

create or replace function public.admin_report_data(p_from date, p_to date, p_basis text default 'visit')
returns jsonb language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_by_booked boolean := p_basis = 'booked';
  v_days integer := p_to - p_from + 1;
  v_prev_from date := p_from - (p_to - p_from + 1);
  v_from_ts timestamptz := p_from::timestamp at time zone 'Africa/Johannesburg';
  v_to_ts timestamptz := (p_to + 1)::timestamp at time zone 'Africa/Johannesburg';
  v_prev_from_ts timestamptz := (p_from - (p_to - p_from + 1))::timestamp at time zone 'Africa/Johannesburg';
  v_result jsonb;
begin
  with period as (
    select b.* from public.bookings b
    where case when v_by_booked then b.created_at >= v_from_ts and b.created_at < v_to_ts
                                 and b.payment_method is distinct from 'IMPORTED'
               else b.visit_date between p_from and p_to end
  ),
  booking_rows as (
    select b.id, b.reference, b.visit_date, b.created_at, b.status, b.payment_method, b.total_amount, b.amount_due,
           b.voucher_amount_used, b.people_count, b.party_slot, b.expires_at, b.voucher_issued,
           c.first_name, c.last_name, c.email, c.phone,
           coalesce(t.issued, 0) as tickets_issued, coalesce(t.used, 0) as tickets_used,
           i.items_summary, coalesce(i.party_children, 0) as party_children, i.party_option, coalesce(i.party_packs, 0) as party_packs,
           (select jsonb_agg(jsonb_build_object('title', bs.snapshot->>'title', 'quantity', bs.quantity)) from public.booking_specials bs where bs.booking_id = b.id) as specials
    from period b
    left join public.customers c on c.id = b.customer_id
    left join lateral (
      select count(*) filter (where status <> 'CANCELLED') as issued, count(*) filter (where status = 'USED') as used
      from public.tickets where booking_id = b.id
    ) t on true
    left join lateral (
      select string_agg(bi.quantity || '× ' || coalesce(bi.metadata->>'name', 'Item'), '; ' order by bi.ctid) -- insertion order, as the items were chosen
               filter (where bi.subtotal > 0 or bi.metadata->>'isPerson' = 'true') as items_summary,
             sum(bi.quantity) filter (where bi.metadata->>'name' like 'Kiddy Party%') as party_children,
             max(bi.metadata->>'name') filter (where bi.metadata->>'name' like 'Kiddy Party%') as party_option,
             sum(bi.quantity) filter (where bi.metadata->>'name' = 'Optional party pack') as party_packs
      from public.booking_items bi where bi.booking_id = b.id
    ) i on true
  ),
  items as (
    select coalesce(bi.metadata->>'name', 'Other') as name, bi.metadata->>'itemId' as item_id,
           coalesce(bi.metadata->>'isPerson', 'false') = 'true' as is_person,
           sum(bi.quantity) as units, sum(bi.subtotal) as revenue, count(distinct bi.booking_id) as bookings
    from public.booking_items bi
    join period b on b.id = bi.booking_id
    where b.status in ('PAID', 'CONFIRMED')
      and coalesce(bi.metadata->>'name', '') <> 'Birthday party child entrance' -- free ticket mirroring the party package line
    group by 1, 2, 3
  ),
  previous as (
    select count(*) as started,
           count(*) filter (where status in ('PAID', 'CONFIRMED')) as paid,
           coalesce(sum(total_amount) filter (where status in ('PAID', 'CONFIRMED')), 0) as revenue,
           coalesce(sum(coalesce(amount_due, total_amount - coalesce(voucher_amount_used, 0))) filter (where status in ('PAID', 'CONFIRMED') and payment_method is distinct from 'IMPORTED'), 0) as collected,
           coalesce(sum(people_count) filter (where status in ('PAID', 'CONFIRMED')), 0) as visitors
    from public.bookings
    where case when v_by_booked then created_at >= v_prev_from_ts and created_at < v_from_ts
                                 and payment_method is distinct from 'IMPORTED'
               else visit_date between v_prev_from and p_from - 1 end
  ),
  returning_emails as (
    select distinct lower(r.email) as email
    from booking_rows r
    where r.status in ('PAID', 'CONFIRMED') and coalesce(r.email, '') <> ''
      and exists (
        select 1 from public.bookings b2
        join public.customers c2 on c2.id = b2.customer_id
        where lower(c2.email) = lower(r.email) and b2.status in ('PAID', 'CONFIRMED')
          and case when v_by_booked then b2.created_at < v_from_ts else b2.visit_date < p_from end
      )
  ),
  specials_stats as (
    select s.id, s.title, s.type,
           coalesce(sum(bs.quantity), 0) as bundles_sold,
           count(distinct bs.booking_id) as bookings,
           coalesce(sum((bs.snapshot->'pricing'->>'price')::numeric * bs.quantity), 0) as revenue,
           coalesce(sum((bs.snapshot->'pricing'->>'discount')::numeric * bs.quantity), 0) as discount_value,
           coalesce(sum(coalesce((bs.snapshot->>'free_tickets_count')::integer, 0) * bs.quantity), 0) as free_tickets,
           count(m.id) as meals_issued,
           count(m.id) filter (where m.status = 'REDEEMED') as meals_redeemed,
           count(m.id) filter (where m.status = 'CANCELLED') as meals_cancelled
    from public.specials s
    left join public.booking_specials bs on bs.special_id = s.id
    left join period b on b.id = bs.booking_id
    left join public.meal_vouchers m on m.booking_id = b.id and m.special_id = s.id
    where b.status in ('PAID', 'CONFIRMED') or b.id is null
    group by s.id, s.title, s.type
    having count(distinct bs.booking_id) > 0
  )
  select jsonb_build_object(
    'bookings', (select coalesce(jsonb_agg(to_jsonb(r) order by r.visit_date, r.created_at), '[]'::jsonb) from booking_rows r),
    'items', (select coalesce(jsonb_agg(to_jsonb(it)), '[]'::jsonb) from items it),
    'previous', (select to_jsonb(p) from previous p),
    'returningEmails', (select coalesce(jsonb_agg(email), '[]'::jsonb) from returning_emails),
    'seating', case when v_by_booked then null else (
      select jsonb_build_object(
        'hutTotal', (select count(*) from public.venue_spots where type = 'hut' and active),
        'tableTotal', (select count(*) from public.venue_spots where type = 'table' and active),
        'hutBooked', count(*) filter (where vs.type = 'hut'),
        'tableBooked', count(*) filter (where vs.type = 'table'))
      from public.booking_spots bs
      join public.bookings b on b.id = bs.booking_id and b.status in ('PAID', 'CONFIRMED')
      join public.venue_spots vs on vs.id = bs.spot_id
      where bs.visit_date between p_from and p_to
    ) end,
    'vouchers', jsonb_build_object(
      'issuedCount', (select count(*) from public.booking_credits where created_at >= v_from_ts and created_at < v_to_ts),
      'issuedValue', (select coalesce(sum(original_amount), 0) from public.booking_credits where created_at >= v_from_ts and created_at < v_to_ts),
      'voidCount', (select count(*) from public.booking_credits where created_at >= v_from_ts and created_at < v_to_ts and status = 'void'),
      'voidValue', (select coalesce(sum(original_amount), 0) from public.booking_credits where created_at >= v_from_ts and created_at < v_to_ts and status = 'void'),
      'redeemedCount', (select count(*) from public.credit_redemptions where created_at >= v_from_ts and created_at < v_to_ts and not coalesce(released, false)),
      'redeemedValue', (select coalesce(sum(amount_used), 0) from public.credit_redemptions where created_at >= v_from_ts and created_at < v_to_ts and not coalesce(released, false)),
      'outstandingCount', (select count(*) from public.booking_credits where status = 'active'),
      'outstandingValue', (select coalesce(sum(remaining_balance), 0) from public.booking_credits where status = 'active')
    ),
    'specials', (select coalesce(jsonb_agg(to_jsonb(ss)), '[]'::jsonb) from specials_stats ss),
    'capacity', coalesce((select daily_capacity from public.business_settings limit 1), 500),
    'days', v_days
  ) into v_result;
  return v_result;
end;
$$;

revoke all on function public.admin_report_data(date, date, text) from public, anon, authenticated;
grant execute on function public.admin_report_data(date, date, text) to service_role;

commit;

notify pgrst, 'reload schema';
