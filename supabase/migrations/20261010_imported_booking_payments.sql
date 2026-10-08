-- 20261010_imported_booking_payments.sql
--
-- Bookings imported from the booking book are kept as PAID (so their seats and
-- capacity stay held), but many were not paid, or only partly paid, before
-- they were copied in. Staff now record what has been paid as payment lines
-- (payments rows, status COMPLETE, provider_reference "IMPORTED-…"), and the
-- outstanding balance is the total less those payments.
--
-- - admin_report_data: every booking row carries amount_paid (its completed
--   payments), and the previous period's "cash collected" counts the payments
--   recorded on imported bookings instead of leaving them out;
-- - issue_booking_voucher: an imported booking is refunded what was actually
--   paid on it, never its full total.
--
-- Safe to run more than once. Apply after 20261009_specials_report_statistics.sql.

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
           (select coalesce(sum(p.amount), 0) from public.payments p where p.booking_id = b.id and p.status = 'COMPLETE') as amount_paid,
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
           coalesce(sum(case when payment_method = 'IMPORTED'
                             then (select coalesce(sum(p.amount), 0) from public.payments p where p.booking_id = pb.id and p.status = 'COMPLETE')
                             else coalesce(amount_due, total_amount - coalesce(voucher_amount_used, 0)) end)
                    filter (where status in ('PAID', 'CONFIRMED')), 0) as collected,
           coalesce(sum(people_count) filter (where status in ('PAID', 'CONFIRMED')), 0) as visitors
    from public.bookings pb
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
  -- Specials sold in this period (paid bookings only). Sales, booking lines and
  -- meal vouchers are each added up on their own, then joined per special, so no
  -- row is counted more than once.
  special_paid as (
    select id from period where status in ('PAID', 'CONFIRMED')
  ),
  special_sales as (
    select bs.special_id, count(distinct bs.booking_id) as bookings, sum(bs.quantity) as bundles_sold
    from public.booking_specials bs
    join special_paid p on p.id = bs.booking_id
    group by bs.special_id
  ),
  special_lines as (
    -- Booking lines carry the special they belong to (metadata.specialId), with
    -- their role and the normal ticket price, from 8 October 2026 onwards.
    select (bi.metadata->>'specialId')::uuid as special_id,
           sum(bi.subtotal) as revenue,
           sum(greatest(coalesce((bi.metadata->>'fullPricePerUnit')::numeric, bi.price_per_unit) - bi.price_per_unit, 0) * bi.quantity) as discount_value,
           coalesce(sum(bi.quantity) filter (where bi.metadata->>'specialRole' = 'free'), 0) as free_tickets
    from public.booking_items bi
    join special_paid p on p.id = bi.booking_id
    where bi.metadata->>'specialId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    group by 1
  ),
  special_meals as (
    select m.special_id,
           count(*) as meals_issued,
           count(*) filter (where m.status = 'REDEEMED') as meals_redeemed,
           count(*) filter (where m.status = 'CANCELLED') as meals_cancelled
    from public.meal_vouchers m
    join special_paid p on p.id = m.booking_id
    group by m.special_id
  ),
  specials_stats as (
    select s.id, s.title, s.type,
           ss.bundles_sold,
           ss.bookings,
           coalesce(sl.revenue, 0) as revenue,
           coalesce(sl.discount_value, 0) as discount_value,
           coalesce(sl.free_tickets, 0) as free_tickets,
           coalesce(sm.meals_issued, 0) as meals_issued,
           coalesce(sm.meals_redeemed, 0) as meals_redeemed,
           coalesce(sm.meals_cancelled, 0) as meals_cancelled
    from special_sales ss
    join public.specials s on s.id = ss.special_id
    left join special_lines sl on sl.special_id = ss.special_id
    left join special_meals sm on sm.special_id = ss.special_id
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

create or replace function public.issue_booking_voucher(
  p_booking_id uuid,
  p_created_by uuid default null,
  p_deduction_percentage numeric default 0,
  p_reason text default 'cancellation'
) returns table(credit_id uuid, credit_code text, original_amount numeric, customer_email text, customer_name text,
                visit_date date, booking_reference text, paid_amount numeric, deduction_percentage numeric)
language plpgsql security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
declare
  v_booking public.bookings%rowtype;
  v_paid numeric(12,2);
  v_amount numeric(12,2);
  v_pct numeric(5,2) := round(coalesce(p_deduction_percentage, 0), 2);
  v_credit_id uuid;
  v_code text;
  v_customer public.customers%rowtype;
begin
  if v_pct < 0 or v_pct >= 100 then raise exception 'The cancellation fee must be between 0%% and 99%%'; end if;
  if coalesce(p_reason, '') not in ('cancellation', 'closure') then raise exception 'Unknown refund reason'; end if;
  select * into v_booking from public.bookings b where b.id = p_booking_id for update;
  if not found then raise exception 'Booking not found'; end if;
  if v_booking.status not in ('PAID', 'CONFIRMED') then raise exception 'Only paid or confirmed bookings can be refunded'; end if;
  if coalesce(v_booking.voucher_issued, false) then raise exception 'Booking has already been refunded'; end if;
  -- Bookings copied in from the booking book only count the payments recorded
  -- against them; one with nothing recorded has nothing to refund.
  select coalesce(sum(p.amount), case when v_booking.payment_method = 'IMPORTED' then 0 else v_booking.total_amount end)::numeric(12,2) into v_paid
    from public.payments p where p.booking_id = v_booking.id and p.status = 'COMPLETE';
  if v_paid <= 0 then raise exception 'Booking has no paid amount to refund'; end if;
  v_amount := round(v_paid * (100 - v_pct) / 100, 2);
  if v_amount <= 0 then raise exception 'The cancellation fee leaves nothing to refund'; end if;
  v_code := public.generate_voucher_code();
  insert into public.booking_credits(credit_code, original_booking_id, original_amount, remaining_balance, created_by,
                                     paid_amount, deduction_percentage, issue_reason)
    values (v_code, v_booking.id, v_amount, v_amount, p_created_by, v_paid, v_pct, p_reason)
    returning id into v_credit_id;
  update public.bookings b
     set status = 'CANCELLED', voucher_issued = true, refunded_at = now(), voucher_credit_id = v_credit_id, amount_due = 0,
         attention_reason = null, attention_at = null
   where b.id = v_booking.id;
  update public.payments p set status = 'REFUNDED' where p.booking_id = v_booking.id and p.status = 'COMPLETE';
  select * into v_customer from public.customers c where c.id = v_booking.customer_id;
  return query select v_credit_id, v_code, v_amount, v_customer.email, concat_ws(' ', v_customer.first_name, v_customer.last_name),
                      v_booking.visit_date, v_booking.reference, v_paid, v_pct;
end;
$$;

revoke all on function public.issue_booking_voucher(uuid, uuid, numeric, text) from public, anon, authenticated;
grant execute on function public.issue_booking_voucher(uuid, uuid, numeric, text) to service_role;

commit;

notify pgrst, 'reload schema';
