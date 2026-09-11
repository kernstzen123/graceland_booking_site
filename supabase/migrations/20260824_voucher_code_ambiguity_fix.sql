-- Follow-up for databases where the voucher code fix was already applied.
create or replace function public.issue_booking_voucher(p_booking_id uuid, p_created_by uuid default null)
returns table(credit_id uuid, credit_code text, original_amount numeric, customer_email text, customer_name text, visit_date date, booking_reference text)
language plpgsql security definer set search_path = public as $$
declare
  v_booking public.bookings%rowtype;
  v_amount numeric(12,2);
  v_credit_id uuid;
  v_code text;
  v_customer public.customers%rowtype;
begin
  select * into v_booking from public.bookings where id = p_booking_id for update;
  if not found then raise exception 'Booking not found'; end if;
  if v_booking.status not in ('PAID', 'CONFIRMED') then raise exception 'Only paid or confirmed bookings can be refunded'; end if;
  if coalesce(v_booking.voucher_issued, false) then raise exception 'Booking has already been refunded'; end if;
  select coalesce(sum(p.amount), v_booking.total_amount)::numeric(12,2) into v_amount
    from public.payments p where p.booking_id = v_booking.id and p.status = 'COMPLETE';
  if v_amount <= 0 then raise exception 'Booking has no paid amount to refund'; end if;
  loop
    v_code := 'GRC-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8));
    exit when not exists (select 1 from public.booking_credits bc where bc.credit_code = v_code);
  end loop;
  insert into public.booking_credits(credit_code, original_booking_id, original_amount, remaining_balance, created_by)
    values (v_code, v_booking.id, v_amount, v_amount, p_created_by) returning id into v_credit_id;
  update public.bookings set status = 'CANCELLED', voucher_issued = true, refunded_at = now(), voucher_credit_id = v_credit_id, amount_due = 0 where id = v_booking.id;
  update public.payments set status = 'REFUNDED' where booking_id = v_booking.id and status = 'COMPLETE';
  select * into v_customer from public.customers where id = v_booking.customer_id;
  return query select v_credit_id, v_code, v_amount, v_customer.email, concat_ws(' ', v_customer.first_name, v_customer.last_name), v_booking.visit_date, v_booking.reference;
end;
$$;
revoke all on function public.issue_booking_voucher(uuid, uuid) from public;
grant execute on function public.issue_booking_voucher(uuid, uuid) to service_role;
