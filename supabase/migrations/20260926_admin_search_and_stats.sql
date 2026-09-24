-- Server-side search and aggregation for the admin dashboard, bookings list and reports.
--
-- These functions do the filtering and adding-up inside Postgres, so the app
-- receives a page of slim rows or ready-made totals instead of every booking
-- with all of its items, payments and tickets.
--
-- All three are only callable with the service role (the Next.js server).

-- Returning-customer checks match on email.
create index if not exists customers_email_lower_idx on public.customers (lower(email));

-- ── Bookings list: search + filters + paging ─────────────────────────────
-- p_status: null (all), 'PAID', 'PENDING', 'CANCELLED' or 'FAILED'.
-- p_query matches the booking reference, customer name or email, or a ticket ID.
create or replace function public.admin_search_bookings(
  p_query text default null,
  p_status text default null,
  p_visit_date date default null,
  p_limit integer default 50,
  p_offset integer default 0
) returns table (
  id uuid, reference text, visit_date date, status text, payment_method text,
  total_amount numeric, people_count integer, voucher_issued boolean, created_at timestamptz,
  first_name text, last_name text, email text, total_count bigint
) language sql stable set search_path = public as $$
  with term as (
    -- Treat % and _ typed by staff as literal characters, not wildcards.
    select '%' || replace(replace(replace(nullif(trim(p_query), ''), '\', '\\'), '%', '\%'), '_', '\_') || '%' as pattern
  ),
  matches as (
    select b.id, b.reference, b.visit_date, b.status, b.payment_method, b.total_amount, b.people_count,
           b.voucher_issued, b.created_at, c.first_name, c.last_name, c.email
    from public.bookings b
    left join public.customers c on c.id = b.customer_id
    cross join term
    where (p_visit_date is null or b.visit_date = p_visit_date)
      and (p_status is null
        or (p_status = 'PAID' and b.status in ('PAID', 'CONFIRMED'))
        or (p_status = 'PENDING' and b.status in ('UNPAID', 'PAYMENT_PENDING'))
        or (p_status = 'CANCELLED' and b.status in ('CANCELLED', 'REFUNDED'))
        or (p_status = 'FAILED' and b.status = 'PAYMENT_FAILED'))
      and (term.pattern is null
        or b.reference ilike term.pattern
        or c.email ilike term.pattern
        or (c.first_name || ' ' || c.last_name) ilike term.pattern
        or exists (select 1 from public.tickets t where t.booking_id = b.id and t.ticket_uid ilike term.pattern))
  )
  select m.*, count(*) over () as total_count
  from matches m
  order by m.created_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

-- ── Dashboard: one day's numbers ─────────────────────────────────────────
create or replace function public.admin_day_overview(p_date date)
returns jsonb language sql stable set search_path = public as $$
  with day as (
    select * from public.bookings where visit_date = p_date
  ),
  paid as (
    select * from day where status in ('PAID', 'CONFIRMED')
  ),
  sales as (
    select coalesce(pk.name, h.name, bi.metadata->>'name', 'Other') as name,
           sum(bi.quantity) as units, sum(bi.subtotal) as revenue
    from public.booking_items bi
    join paid p on p.id = bi.booking_id
    left join public.packages pk on pk.id = bi.package_id
    left join public.huts h on h.id = bi.hut_id
    group by 1
  )
  select jsonb_build_object(
    'headcount', (select coalesce(sum(people_count), 0) from paid),
    'revenue', (select coalesce(sum(total_amount), 0) from paid),
    'bookings', (select count(*) from day),
    'breakdown', (select coalesce(jsonb_object_agg(name, jsonb_build_object('units', units, 'revenue', revenue)), '{}'::jsonb) from sales),
    'unscanned', (select count(*) from public.tickets t join paid p on p.id = t.booking_id where t.status = 'VALID'),
    'scanned', (select count(*) from public.tickets t join day d on d.id = t.booking_id where t.status = 'USED'),
    'lastWeekHeadcount', (select coalesce(sum(people_count), 0) from public.bookings where visit_date = p_date - 7 and status in ('PAID', 'CONFIRMED')),
    'pendingProofs', (select count(*) from public.payment_proofs where status = 'PENDING'),
    'capacity', coalesce((select daily_capacity from public.business_settings limit 1), 500)
  );
$$;

-- ── Reports: everything the report needs for a period, in one call ──────
-- p_basis 'visit' counts bookings by visit date; 'booked' by the date they were made
-- (South African time). The previous period is the same number of days just before.
create or replace function public.admin_report_data(p_from date, p_to date, p_basis text default 'visit')
returns jsonb language plpgsql stable set search_path = public as $$
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
        'hutTotal', (select count(*) from public.venue_spots where type = 'hut'),
        'tableTotal', (select count(*) from public.venue_spots where type = 'table'),
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

revoke all on function public.admin_search_bookings(text, text, date, integer, integer) from public, anon, authenticated;
revoke all on function public.admin_day_overview(date) from public, anon, authenticated;
revoke all on function public.admin_report_data(date, date, text) from public, anon, authenticated;
grant execute on function public.admin_search_bookings(text, text, date, integer, integer) to service_role;
grant execute on function public.admin_day_overview(date) to service_role;
grant execute on function public.admin_report_data(date, date, text) to service_role;
