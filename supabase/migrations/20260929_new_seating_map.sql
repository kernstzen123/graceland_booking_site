-- New venue seating map (public/venue-map-2026.webp, 1022 × 713).
--
-- 16 covered huts (H1–H16, 14 people each) and 12 shaded tables (T1–T12,
-- 6 people each), positioned as percentages of the image.
--
-- The previous map's spots (numbered 1–28) are retired, not deleted or
-- renumbered: bookings that already have one keep it (and its label on their
-- tickets), but it can no longer be chosen for new bookings.
--
-- Apply BEFORE deploying the matching code. Safe to run twice.

begin;

alter table public.venue_spots add column if not exists active boolean not null default true;

-- Retire the old map's spots.
update public.venue_spots set active = false where number !~ '^[HT][0-9]+$';

insert into public.venue_spots(number, type, capacity, x_percent, y_percent, active) values
  ('H1',  'hut',   14, 12.38, 27.90, true),
  ('H2',  'hut',   14, 19.56, 27.29, true),
  ('H3',  'hut',   14, 33.56, 25.08, true),
  ('H4',  'hut',   14, 41.50, 24.47, true),
  ('H5',  'hut',   14, 48.42, 23.86, true),
  ('H6',  'hut',   14, 50.98, 32.55, true),
  ('H7',  'hut',   14, 67.89, 22.02, true),
  ('H8',  'hut',   14, 93.42, 19.82, true),
  ('H9',  'hut',   14, 95.05, 70.99, true),
  ('H10', 'hut',   14, 72.67, 38.18, true),
  ('H11', 'hut',   14, 64.22, 41.73, true),
  ('H12', 'hut',   14, 71.73, 83.72, true),
  ('H13', 'hut',   14, 17.16, 70.37, true),
  ('H14', 'hut',   14, 20.84, 70.74, true),
  ('H15', 'hut',   14, 17.08, 77.60, true),
  ('H16', 'hut',   14, 20.41, 77.47, true),
  ('T1',  'table',  6, 55.51, 31.69, true),
  ('T2',  'table',  6, 55.94, 23.12, true),
  ('T3',  'table',  6, 61.40, 22.88, true),
  ('T4',  'table',  6, 39.62, 40.51, true),
  ('T5',  'table',  6, 44.49, 46.63, true),
  ('T6',  'table',  6, 40.14, 53.24, true),
  ('T7',  'table',  6, 35.44, 46.99, true),
  ('T8',  'table',  6,  1.45, 49.69, true),
  ('T9',  'table',  6,  6.49, 49.44, true),
  ('T10', 'table',  6, 11.96, 49.56, true),
  ('T11', 'table',  6, 16.82, 50.54, true),
  ('T12', 'table',  6, 20.67, 52.87, true)
on conflict (number) do update
  set type = excluded.type, capacity = excluded.capacity,
      x_percent = excluded.x_percent, y_percent = excluded.y_percent, active = true;

-- reserve_booking_spots: unchanged, except that retired spots are refused.
create or replace function public.reserve_booking_spots(p_booking_id uuid, p_visit_date date, p_spot_ids uuid[])
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_existing_count integer;
  v_requested_count integer := coalesce(array_length(p_spot_ids, 1), 0);
  v_duplicate_count integer;
begin
  if v_requested_count = 0 then return; end if;
  perform pg_advisory_xact_lock(hashtextextended('graceland-seating-' || p_visit_date::text, 0));
  select count(*) into v_duplicate_count from (select distinct unnest(p_spot_ids)) spots;
  if v_duplicate_count <> v_requested_count then raise exception 'A seating spot was selected more than once'; end if;
  if (select count(*) from public.venue_spots vs where vs.id = any(p_spot_ids) and vs.active) <> v_requested_count then
    raise exception 'One of the selected seating spots is invalid.';
  end if;
  if exists (select 1 from public.booking_spots bs join public.bookings b on b.id = bs.booking_id where bs.visit_date = p_visit_date and bs.spot_id = any(p_spot_ids) and bs.booking_id <> p_booking_id and b.status in ('UNPAID','PAYMENT_PENDING','PAID','CONFIRMED') and (b.status <> 'UNPAID' or b.expires_at > now())) then
    raise exception 'This seating spot was just taken. Please choose another spot.';
  end if;
  select count(*) into v_existing_count from public.booking_spots where booking_id = p_booking_id;
  if v_existing_count > 0 then delete from public.booking_spots where booking_id = p_booking_id; end if;
  insert into public.booking_spots(booking_id, spot_id, visit_date) select p_booking_id, spot_id, p_visit_date from unnest(p_spot_ids) spot_id;
end;
$$;

-- admin_report_data: unchanged from 20260926, except that the hut and table
-- totals count only the spots on the current map.
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
               else b.visit_date between p_from and p_to end
  ),
  booking_rows as (
    select b.id, b.reference, b.visit_date, b.created_at, b.status, b.payment_method, b.total_amount, b.amount_due,
           b.voucher_amount_used, b.people_count, b.party_slot, b.expires_at, b.voucher_issued,
           c.first_name, c.last_name, c.email, c.phone,
           coalesce(t.issued, 0) as tickets_issued, coalesce(t.used, 0) as tickets_used,
           i.items_summary, coalesce(i.party_children, 0) as party_children, i.party_option, coalesce(i.party_packs, 0) as party_packs
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
           coalesce(sum(coalesce(amount_due, total_amount - coalesce(voucher_amount_used, 0))) filter (where status in ('PAID', 'CONFIRMED')), 0) as collected,
           coalesce(sum(people_count) filter (where status in ('PAID', 'CONFIRMED')), 0) as visitors
    from public.bookings
    where case when v_by_booked then created_at >= v_prev_from_ts and created_at < v_from_ts
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
    'capacity', coalesce((select daily_capacity from public.business_settings limit 1), 500),
    'days', v_days
  ) into v_result;
  return v_result;
end;
$$;

-- The business uses gracelandvenuespaarl.co.za: replace the earlier default
-- support address (an address an admin changed by hand is left alone).
update public.business_settings
   set support_email = 'support@gracelandvenuespaarl.co.za'
 where support_email = 'support@graceland-venues.co.za';

revoke all on function public.reserve_booking_spots(uuid, date, uuid[]) from public, anon, authenticated;
revoke all on function public.admin_report_data(date, date, text) from public, anon, authenticated;
grant execute on function public.reserve_booking_spots(uuid, date, uuid[]) to service_role;
grant execute on function public.admin_report_data(date, date, text) to service_role;

commit;

notify pgrst, 'reload schema';
