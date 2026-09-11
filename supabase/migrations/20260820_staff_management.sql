alter table public.admin_roles add column if not exists display_name text;
alter table public.admin_roles add column if not exists active boolean not null default true;
alter table public.admin_roles add column if not exists created_at timestamptz not null default now();
alter table public.admin_roles add column if not exists updated_at timestamptz not null default now();
update public.admin_roles set active = true where active is null;

drop policy if exists "admins manage staff roles" on public.admin_roles;
create policy "admins manage staff roles" on public.admin_roles for all to authenticated
using (public.current_staff_role() = 'ADMIN')
with check (public.current_staff_role() = 'ADMIN');

create or replace function public.current_staff_role()
returns text language sql stable security definer set search_path = public
as $$ select upper(role) from public.admin_roles where id = auth.uid() and active = true $$;

create or replace function public.prevent_last_admin_deactivation()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.role = 'ADMIN' and old.active = true and (new.active = false or new.role <> 'ADMIN') then
    if (select count(*) from public.admin_roles where role = 'ADMIN' and active = true and id <> old.id) < 1 then
      raise exception 'At least one active admin must remain.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_last_admin on public.admin_roles;
create trigger protect_last_admin before update on public.admin_roles for each row execute function public.prevent_last_admin_deactivation();

alter table public.admin_audit_log alter column actor_id drop not null;
alter table public.admin_audit_log drop constraint if exists admin_audit_log_actor_id_fkey;
alter table public.admin_audit_log add constraint admin_audit_log_actor_id_fkey
  foreign key (actor_id) references auth.users(id) on delete set null;
