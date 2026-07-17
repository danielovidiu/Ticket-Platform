-- Serves both the past-project archive and upcoming events list; which one a
-- row appears in is derived purely from event_date vs now(), not a separate table.
create table public.projects (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  event_date timestamptz not null,
  event_end_date timestamptz,
  venue_name text,
  venue_address text,
  cover_image_url text,
  description text,
  is_published boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.projects enable row level security;

create trigger projects_set_updated_at
  before update on public.projects
  for each row execute function public.set_updated_at();

create policy "projects_select_published_or_admin"
  on public.projects for select
  to anon, authenticated
  using (is_published = true or public.is_admin());

create policy "projects_write_admin_only"
  on public.projects for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());
