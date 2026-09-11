create table if not exists public.api_rate_limits (
  rate_key text primary key,
  window_started timestamptz not null default now(),
  request_count integer not null default 1
);

create or replace function public.check_api_rate_limit(
  p_key text,
  p_limit integer,
  p_window_seconds integer
) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  current_started timestamptz;
  current_count integer;
begin
  if p_limit < 1 or p_window_seconds < 1 then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_key, 0));
  select window_started, request_count into current_started, current_count
  from public.api_rate_limits where rate_key = p_key for update;
  if not found then
    insert into public.api_rate_limits(rate_key, window_started, request_count) values (p_key, now(), 1);
    return true;
  end if;
  if current_started + make_interval(secs => p_window_seconds) <= now() then
    update public.api_rate_limits set window_started = now(), request_count = 1 where rate_key = p_key;
    return true;
  end if;
  update public.api_rate_limits set request_count = current_count + 1 where rate_key = p_key;
  return current_count + 1 <= p_limit;
end;
$$;

revoke all on function public.check_api_rate_limit(text, integer, integer) from public;
grant execute on function public.check_api_rate_limit(text, integer, integer) to service_role;
