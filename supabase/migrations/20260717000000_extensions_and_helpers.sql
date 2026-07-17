-- Extensions
create extension if not exists pgcrypto;
create extension if not exists citext;

-- Role-check helpers used inside RLS policies.
-- security definer + a pinned search_path lets these read `profiles` even though
-- the calling role (anon/authenticated) has no direct RLS access to other users' rows.
create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

create or replace function public.is_staff()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('admin', 'door_staff')
  );
$$;

-- Without this grant, RLS policies calling is_admin()/is_staff() fail with
-- "permission denied for function" for anon/authenticated callers.
grant execute on function public.is_admin() to anon, authenticated;
grant execute on function public.is_staff() to anon, authenticated;

-- Generic updated_at maintenance trigger, reused by every table that has the column.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
