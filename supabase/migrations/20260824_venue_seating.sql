create table if not exists public.venue_spots (
  id uuid primary key default uuid_generate_v4(),
  number text not null unique,
  type text not null check (type in ('table', 'hut')),
  capacity integer not null check (capacity > 0),
  x_percent numeric(6,2) not null check (x_percent between 0 and 100),
  y_percent numeric(6,2) not null check (y_percent between 0 and 100)
);

create table if not exists public.booking_spots (
  id uuid primary key default uuid_generate_v4(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  spot_id uuid not null references public.venue_spots(id) on delete restrict,
  visit_date date not null,
  created_at timestamptz not null default now(),
  unique (booking_id, spot_id)
);

create index if not exists booking_spots_date_idx on public.booking_spots(visit_date, spot_id);
create index if not exists booking_spots_booking_idx on public.booking_spots(booking_id);

insert into public.venue_spots(number, type, capacity, x_percent, y_percent) values
('1','hut',16,76.02,50.79),('2','hut',16,71.17,54.28),('3','hut',16,55.18,63.80),('4','hut',16,49.15,67.14),
('5','hut',16,42.60,70.79),('6','hut',16,40.89,64.76),('7','table',6,37.09,67.77),('8','hut',16,38.93,72.69),
('9','hut',16,36.04,74.60),('10','hut',16,32.77,76.18),('11','table',6,15.73,82.53),('12','hut',16,25.69,69.83),
('13','hut',16,29.88,64.91),('14','hut',16,10.09,62.53),('15','hut',16,18.22,47.61),('16','table',6,46.00,54.44),
('17','table',6,48.62,50.00),('18','table',6,50.98,55.39),('19','table',6,52.29,50.31),('20','table',6,62.65,38.89),
('21','table',6,68.28,36.66),('22','table',6,73.92,35.55),('23','table',6,78.90,32.22),('24','table',6,78.90,25.55),
('25','hut',16,55.18,27.46),('26','hut',16,52.69,23.65),('27','hut',16,57.27,19.52),('28','hut',16,59.90,23.65)
on conflict (number) do update set type = excluded.type, capacity = excluded.capacity, x_percent = excluded.x_percent, y_percent = excluded.y_percent;

alter table public.venue_spots enable row level security;
alter table public.booking_spots enable row level security;
drop policy if exists "public can view venue spots" on public.venue_spots;
create policy "public can view venue spots" on public.venue_spots for select to anon, authenticated using (true);
drop policy if exists "admins manage venue spots" on public.venue_spots;
create policy "admins manage venue spots" on public.venue_spots for all to authenticated using (public.current_staff_role() = 'ADMIN') with check (public.current_staff_role() = 'ADMIN');
drop policy if exists "admins read booking spots" on public.booking_spots;
create policy "admins read booking spots" on public.booking_spots for select to authenticated using (public.current_staff_role() in ('ADMIN', 'MANAGER', 'SCANNER'));
drop policy if exists "customers read own booking spots" on public.booking_spots;
create policy "customers read own booking spots" on public.booking_spots for select to authenticated using (exists (select 1 from public.bookings b join public.customers c on c.id = b.customer_id where b.id = booking_spots.booking_id and lower(c.email) = lower((select auth.jwt() ->> 'email'))));

create or replace function public.reserve_booking_spots(p_booking_id uuid, p_visit_date date, p_spot_ids uuid[])
returns void language plpgsql security definer set search_path = public as $$
declare
  v_existing_count integer;
  v_requested_count integer := coalesce(array_length(p_spot_ids, 1), 0);
  v_duplicate_count integer;
begin
  if v_requested_count = 0 then return; end if;
  perform pg_advisory_xact_lock(hashtextextended('graceland-seating-' || p_visit_date::text, 0));
  select count(*) into v_duplicate_count from (select distinct unnest(p_spot_ids)) spots;
  if v_duplicate_count <> v_requested_count then raise exception 'A seating spot was selected more than once'; end if;
  if exists (select 1 from public.booking_spots bs join public.bookings b on b.id = bs.booking_id where bs.visit_date = p_visit_date and bs.spot_id = any(p_spot_ids) and bs.booking_id <> p_booking_id and b.status in ('UNPAID','PAYMENT_PENDING','PAID','CONFIRMED') and (b.status <> 'UNPAID' or b.expires_at > now())) then
    raise exception 'This seating spot was just taken. Please choose another spot.';
  end if;
  select count(*) into v_existing_count from public.booking_spots where booking_id = p_booking_id;
  if v_existing_count > 0 then delete from public.booking_spots where booking_id = p_booking_id; end if;
  insert into public.booking_spots(booking_id, spot_id, visit_date) select p_booking_id, spot_id, p_visit_date from unnest(p_spot_ids) spot_id;
end;
$$;
revoke all on function public.reserve_booking_spots(uuid, date, uuid[]) from public;
grant execute on function public.reserve_booking_spots(uuid, date, uuid[]) to service_role;
