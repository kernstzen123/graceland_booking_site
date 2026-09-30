-- Staff search ("Find booking or ticket" and All bookings) also finds a
-- booking by the customer's phone number, typed with or without spaces.
-- Used for bookings imported from the paper booking book, which staff look up
-- by name, phone or email instead of scanning a QR code.
-- Unchanged otherwise from 20260927_security_hardening.sql. Safe to run more than once.

create or replace function public.admin_search_bookings(
  p_query text default null,
  p_status text default null,
  p_visit_date date default null,
  p_limit integer default 50,
  p_offset integer default 0
) returns table (
  id uuid, reference text, visit_date date, status text, payment_method text,
  total_amount numeric, people_count integer, voucher_issued boolean, created_at timestamptz,
  first_name text, last_name text, email text, attention_reason text, deleted_at timestamptz, total_count bigint
) language sql stable set search_path = public, pg_temp as $$
  with term as (
    -- Treat % and _ typed by staff as literal characters, not wildcards.
    select '%' || replace(replace(replace(nullif(trim(p_query), ''), '\', '\\'), '%', '\%'), '_', '\_') || '%' as pattern,
           -- A phone number typed with or without spaces: match on its digits.
           case when length(regexp_replace(coalesce(p_query, ''), '\D', '', 'g')) >= 6
                then '%' || regexp_replace(p_query, '\D', '', 'g') || '%' end as digits
  ),
  matches as (
    select b.id, b.reference, b.visit_date, b.status, b.payment_method, b.total_amount, b.people_count,
           b.voucher_issued, b.created_at, c.first_name, c.last_name, c.email, b.attention_reason, b.deleted_at
    from public.bookings b
    left join public.customers c on c.id = b.customer_id
    cross join term
    where (p_visit_date is null or b.visit_date = p_visit_date)
      and case p_status
            when 'DELETED' then b.deleted_at is not null
            when 'ATTENTION' then b.attention_reason is not null
            else b.deleted_at is null
          end
      and (p_status is null or p_status in ('DELETED', 'ATTENTION')
        or (p_status = 'PAID' and b.status in ('PAID', 'CONFIRMED'))
        or (p_status = 'PENDING' and b.status in ('UNPAID', 'PAYMENT_PENDING'))
        or (p_status = 'CANCELLED' and b.status in ('CANCELLED', 'REFUNDED'))
        or (p_status = 'FAILED' and b.status = 'PAYMENT_FAILED'))
      and (term.pattern is null
        or b.reference ilike term.pattern
        or c.email ilike term.pattern
        or (c.first_name || ' ' || c.last_name) ilike term.pattern
        or (term.digits is not null and regexp_replace(coalesce(c.phone, ''), '\D', '', 'g') like term.digits)
        or exists (select 1 from public.tickets t where t.booking_id = b.id and t.ticket_uid ilike term.pattern))
  )
  select m.*, count(*) over () as total_count
  from matches m
  order by m.created_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

revoke all on function public.admin_search_bookings(text, text, date, integer, integer) from public, anon, authenticated;
grant execute on function public.admin_search_bookings(text, text, date, integer, integer) to service_role;
