-- Staff/audit support for the protected admin application.
create table if not exists public.admin_audit_log (
  id uuid primary key default uuid_generate_v4(),
  actor_id uuid not null references auth.users(id),
  action text not null,
  entity_type text not null,
  entity_id text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.admin_roles enable row level security;
alter table public.admin_audit_log enable row level security;
alter table public.payment_proofs enable row level security;
alter table public.tickets enable row level security;
alter table public.ticket_scans enable row level security;

create or replace function public.current_staff_role()
returns text language sql stable security definer set search_path = public
as $$ select upper(role) from public.admin_roles where id = auth.uid() $$;

create policy "staff can read own role" on public.admin_roles for select to authenticated using (id = auth.uid());
create policy "management reads audit log" on public.admin_audit_log for select to authenticated using (public.current_staff_role() in ('ADMIN', 'MANAGER'));
create policy "staff writes audit log" on public.admin_audit_log for insert to authenticated with check (actor_id = auth.uid() and public.current_staff_role() in ('ADMIN', 'MANAGER', 'SCANNER'));
create policy "management manages proofs" on public.payment_proofs for all to authenticated using (public.current_staff_role() in ('ADMIN', 'MANAGER')) with check (public.current_staff_role() in ('ADMIN', 'MANAGER'));
create policy "staff reads tickets" on public.tickets for select to authenticated using (public.current_staff_role() in ('ADMIN', 'MANAGER', 'SCANNER'));
create policy "staff updates tickets" on public.tickets for update to authenticated using (public.current_staff_role() in ('ADMIN', 'MANAGER', 'SCANNER')) with check (public.current_staff_role() in ('ADMIN', 'MANAGER', 'SCANNER'));
create policy "staff inserts scans" on public.ticket_scans for insert to authenticated with check (scanned_by = auth.uid() and public.current_staff_role() in ('ADMIN', 'MANAGER', 'SCANNER'));
create policy "management reads scans" on public.ticket_scans for select to authenticated using (public.current_staff_role() in ('ADMIN', 'MANAGER'));

insert into storage.buckets (id, name, public) values ('payment-proofs', 'payment-proofs', false) on conflict (id) do update set public = false;
