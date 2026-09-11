create or replace function public.invalidate_booking_tickets()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status in ('CANCELLED', 'REFUNDED') and old.status is distinct from new.status then
    update public.tickets set status = 'CANCELLED' where booking_id = new.id and status = 'VALID';
  end if;
  return new;
end;
$$;

drop trigger if exists bookings_invalidate_tickets on public.bookings;
create trigger bookings_invalidate_tickets
after update of status on public.bookings
for each row execute function public.invalidate_booking_tickets();
