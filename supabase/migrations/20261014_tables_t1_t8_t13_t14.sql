-- 20261014_tables_t1_t8_t13_t14.sql
--
-- Seating map (public/venue-map-new.jpg, 1024 × 922): measured positions for
-- shaded tables T1–T12, and two new shaded tables, T13 and T14 (6 people
-- each). Positions are percentages of the map image.
--
-- Moving a table only moves its marker on the map: bookings that already have
-- a table keep it. The huts are not touched.
--
-- Safe to run more than once (also after an earlier version of this file).
-- Apply after 20261013_staff_bookings_never_lapse.sql.

begin;

update public.venue_spots s
   set x_percent = v.x, y_percent = v.y
  from (values
    ('T1',  53.59, 28.39),
    ('T2',  56.62, 26.12),
    ('T3',  59.23, 24.31),
    ('T4',  62.42, 22.04),
    ('T5',  55.96, 31.93),
    ('T6',  58.58, 29.75),
    ('T7',  61.11, 27.76),
    ('T8',  64.30, 25.94),
    ('T9',  49.59, 58.34),
    ('T10', 54.58, 58.70),
    ('T11', 53.02, 63.60),
    ('T12', 48.28, 62.87)
  ) as v(number, x, y)
 where s.number = v.number and s.type = 'table';

insert into public.venue_spots(number, type, capacity, x_percent, y_percent, active) values
  ('T13', 'table', 6, 46.16, 65.96, true),
  ('T14', 'table', 6, 43.79, 61.78, true)
on conflict (number) do update
  set type = excluded.type, capacity = excluded.capacity,
      x_percent = excluded.x_percent, y_percent = excluded.y_percent, active = true;

commit;

-- Check: every table and where it sits on the map.
select number, capacity, x_percent, y_percent, active
  from public.venue_spots
 where type = 'table'
 order by length(number), number;
