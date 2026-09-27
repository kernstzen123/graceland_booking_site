# Database

The app talks to Supabase only from the Next.js server, using the service role
key. Browsers never read tables or call database functions directly: the
public (anon) key is only used for staff sign-in. The database is locked down
to match. After `migrations/20260927_security_hardening.sql`:

- the anon key and signed-in users have no access to any table or function in
  the `public` schema (every request goes through the API routes);
- row level security is on for every table, as a second layer;
- every `security definer` function has a fixed `search_path`.

## Applying a migration

Migrations in `migrations/` are applied by hand, in filename order, in the
Supabase dashboard → **SQL Editor**:

1. Open the new file, copy all of it, paste it into a new query and run it.
2. Check the output for errors (a `NOTICE` is fine).
3. Only then deploy the code that needs it.

For `20260927_security_hardening.sql`, confirm the lockdown afterwards:

```bash
node --env-file=.env.local scripts/verify-db-security.mjs
```

It should end with "The anon key cannot read tables or call functions."
It uses only the public key and changes nothing.

The migration also schedules the voucher release job with `pg_cron`. If the
output shows a NOTICE saying it could not be scheduled, enable **pg_cron** under
**Database → Extensions** and run the `cron.schedule(...)` line from that notice.
Check the job with `select * from cron.job;`.

## Writing a new migration

- Name it `YYYYMMDD_short_description.sql` so it sorts after the others.
- Make it safe to run twice (`if not exists`, `create or replace`, `drop … if exists`).
- New tables: `alter table public.<name> enable row level security;` (no
  policies are needed, the server uses the service role).
- New functions: Postgres lets everyone execute a new function by default, so end with

  ```sql
  revoke all on function public.<name>(<arg types>) from public, anon, authenticated;
  grant execute on function public.<name>(<arg types>) to service_role;
  ```

  and give `security definer` functions `set search_path = public, pg_temp`.
- If browser code ever needs direct table access (e.g. realtime), add explicit
  grants and row level security policies for that table only. Do not grant the
  existing `for all` staff policies back to `authenticated`: they would let staff
  change voucher balances directly.

## Keeping the repository in sync with the live database (Supabase CLI)

`schema.sql` plus these migrations are hand-maintained. To get an exact copy of
the live schema into the repository, and catch anything that was changed in the
dashboard, use the Supabase CLI once (it needs the database password from
Dashboard → Project Settings → Database):

```bash
npx supabase login
npx supabase init
npx supabase link --project-ref tguabyipjjwnsopzscjt
npx supabase db pull
```

`db pull` writes the current live schema as one new migration. The CLI needs
unique migration versions, so move the existing hand-written files into
`migrations/archive/` first and keep the pulled file as the baseline. From then
on, create migrations with `npx supabase migration new <name>` and apply them
with `npx supabase db push`, instead of pasting into the SQL editor.
