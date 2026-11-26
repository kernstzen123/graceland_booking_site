-- 20261017_booking_qr_checkin.sql
--
-- One QR code per booking. Customers get a single QR code for their whole
-- booking; staff scan it once and check in the group (or part of it).
--
--   * bookings.qr_token: the booking's signed QR code (made by the website, the
--     same way ticket QR codes are). Filled in when the booking email is sent,
--     so existing bookings get one the next time they are emailed.
--   * check_in_booking(): checks in a number of a booking's people in one go.
--     Each person still has their own ticket behind the scenes (reports, visitor
--     counts and check-in history are unchanged); this marks the next N unused
--     tickets as used and records a scan for each. The booking row is locked,
--     so two scans at the same moment cannot check in more people than booked.
--     Unpaid bookings that still hold their places can be checked in (the
--     scanner shows a NOT PAID warning); cancelled, deleted or refunded ones,
--     and bookings for another day, cannot.
--
-- Nothing is changed on existing bookings, tickets or payments.
-- Safe to run more than once. Apply after 20261016_expire_online_unpaid_bookings.sql.

begin;

alter table public.bookings add column if not exists qr_token text;
create unique index if not exists bookings_qr_token_key on public.bookings(qr_token) where qr_token is not null;

create or replace function public.check_in_booking(p_booking_id uuid, p_count integer, p_scanned_by uuid, p_device_id text default null)
returns table(ok boolean, reason text, detail text, checked_in text[], used integer, total integer)
language plpgsql security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
declare
  v_booking public.bookings%rowtype;
  v_today date := (now() at time zone 'Africa/Johannesburg')::date;
  v_ids uuid[];
  v_uids text[];
  v_used integer;
  v_total integer;
begin
  if p_count is null or p_count < 1 or p_count > 500 then raise exception 'Invalid number of people to check in'; end if;

  select * into v_booking from public.bookings b where b.id = p_booking_id for update;
  if not found then
    return query select false, 'NOT_FOUND'::text, 'Booking not found.'::text, array[]::text[], 0, 0; return;
  end if;

  select count(*) filter (where t.status = 'USED'), count(*) filter (where t.status <> 'CANCELLED')
    into v_used, v_total from public.tickets t where t.booking_id = p_booking_id;

  if v_booking.deleted_at is not null or v_booking.status in ('CANCELLED', 'REFUNDED') or coalesce(v_booking.voucher_issued, false) then
    return query select false, 'CANCELLED'::text, 'This booking has been cancelled.'::text, array[]::text[], v_used, v_total; return;
  end if;
  if not (v_booking.status in ('PAID', 'CONFIRMED', 'PAYMENT_PENDING') or (v_booking.status = 'UNPAID' and v_booking.expires_at > now())) then
    return query select false, 'NOT_ACTIVE'::text, 'This booking is no longer active: it was not paid in time.'::text, array[]::text[], v_used, v_total; return;
  end if;
  if v_booking.visit_date is distinct from v_today then
    return query select false, 'WRONG_DATE'::text, format('This booking is for %s, not today.', to_char(v_booking.visit_date, 'DD Mon YYYY')), array[]::text[], v_used, v_total; return;
  end if;

  select array_agg(t.id order by t.issued_at, t.ticket_uid)
    into v_ids
    from (select tk.id, tk.ticket_uid, tk.issued_at from public.tickets tk
           where tk.booking_id = p_booking_id and tk.status = 'VALID'
           order by tk.issued_at, tk.ticket_uid limit p_count) t;
  if v_ids is null then
    return query select false, case when v_total = 0 then 'NO_TICKETS' else 'ALL_USED' end::text,
      case when v_total = 0 then 'This booking has no tickets yet.' else 'Everyone on this booking is already checked in.' end::text,
      array[]::text[], v_used, v_total;
    return;
  end if;

  with claimed as (
    update public.tickets t set status = 'USED' where t.id = any(v_ids) and t.status = 'VALID' returning t.id, t.ticket_uid
  ), scans as (
    insert into public.ticket_scans(ticket_id, scanned_by, result_status, device_id)
    select c.id, p_scanned_by, 'APPROVED', p_device_id from claimed c returning ticket_id
  )
  select array_agg(c.ticket_uid order by c.ticket_uid) into v_uids from claimed c;

  return query select true, null::text, null::text, coalesce(v_uids, array[]::text[]), v_used + coalesce(array_length(v_uids, 1), 0), v_total;
end;
$$;

revoke all on function public.check_in_booking(uuid, integer, uuid, text) from public, anon, authenticated;
grant execute on function public.check_in_booking(uuid, integer, uuid, text) to service_role;

commit;
