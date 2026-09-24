-- Walk-in / gate sales.
--
-- Walk-in bookings are ordinary bookings with payment_method GATE_CASH,
-- GATE_CARD or GATE_OTHER. sold_by records the staff member who made the sale
-- so the daily cash-up can be split per person.
alter table public.bookings add column if not exists sold_by uuid references auth.users(id) on delete set null;

create index if not exists bookings_gate_sales_idx on public.bookings(visit_date, payment_method) where payment_method like 'GATE_%';
