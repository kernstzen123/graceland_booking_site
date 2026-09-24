-- Admin-managed prices and closed dates.
--
-- price_settings holds overrides for the defaults in src/lib/pricing.ts. A
-- missing row means "use the code default", so this table starts empty and the
-- site keeps charging the current prices until an admin changes one.
create table if not exists public.price_settings (
  key text primary key,
  price numeric(10,2) not null check (price >= 0 and price <= 100000),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

-- closed_dates are ad-hoc closures (maintenance, weather, private events) that
-- apply on top of the regular opening rules in src/lib/opening-rules.ts.
create table if not exists public.closed_dates (
  date date primary key,
  reason text not null default '' check (char_length(reason) <= 200),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null
);

-- Only the server (service role) reads and writes these tables.
alter table public.price_settings enable row level security;
alter table public.closed_dates enable row level security;

-- Reports filter bookings by visit date and by creation date.
create index if not exists bookings_visit_date_idx on public.bookings(visit_date);
create index if not exists bookings_created_at_idx on public.bookings(created_at);
