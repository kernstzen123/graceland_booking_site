-- 20261014_tables_t1_t8_t13_t14.sql
--
-- Seating map (public/venue-map-new.jpg): new positions for shaded tables
-- T1–T8, and two new shaded tables, T13 and T14 (6 people each). Positions
-- are percentages of the map image, as staff measured them.
--
-- Moving a table only moves its marker on the map: bookings that already have
-- T1–T8 keep them. T9–T12 and the huts are not touched.
--
-- Safe to run more than once. Apply after 20261013_staff_bookings_never_lapse.sql.

begin;

update public.venue_spots s
   set x_percent = v.x, y_percent = v.y
  from (values
    ('T1', 52.93, 31.90),
    ('T2', 55.17, 30.27),
    ('T3', 57.53, 28.83),
    ('T4', 59.83, 27.33),
    ('T5', 54.83, 35.57),
    ('T6', 57.01, 33.93),
    ('T7', 59.37, 32.36),
    ('T8', 61.72, 30.79)
  ) as v(number, x, y)
 where s.number = v.number and s.type = 'table';

insert into public.venue_spots(number, type, capacity, x_percent, y_percent, active) values
  ('T13', 'table', 6, 45.92, 64.79, true),
  ('T14', 'table', 6, 44.25, 60.94, true)
on conflict (number) do update
  set type = excluded.type, capacity = excluded.capacity,
      x_percent = excluded.x_percent, y_percent = excluded.y_percent, active = true;

commit;

-- Check: every table and where it sits on the map.
select number, capacity, x_percent, y_percent, active
  from public.venue_spots
 where type = 'table'
 order by length(number), number;
