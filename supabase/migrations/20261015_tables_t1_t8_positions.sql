-- 20261015_tables_t1_t8_positions.sql
--
-- Seating map (public/venue-map-new.jpg, 1024 × 922): new positions for shaded
-- tables T1–T8, measured on that image. T1–T4 are now the front row (nearest
-- the lawn) and T5–T8 the back row. Positions are percentages of the map image.
--
-- Moving a table only moves its marker on the map: bookings that already have
-- a table keep it. T9–T14 and the huts are not touched.
--
-- Safe to run more than once. Apply after 20261014_tables_t1_t8_t13_t14.sql.

begin;

update public.venue_spots s
   set x_percent = v.x, y_percent = v.y
  from (values
    ('T1', 57.15, 32.21),
    ('T2', 60.24, 30.24),
    ('T3', 62.68, 28.66),
    ('T4', 65.16, 26.69),
    ('T5', 55.22, 28.49),
    ('T6', 57.86, 26.86),
    ('T7', 60.19, 25.00),
    ('T8', 62.78, 23.42)
  ) as v(number, x, y)
 where s.number = v.number and s.type = 'table';

commit;

-- Check: every table and where it sits on the map.
select number, capacity, x_percent, y_percent, active
  from public.venue_spots
 where type = 'table'
 order by length(number), number;
