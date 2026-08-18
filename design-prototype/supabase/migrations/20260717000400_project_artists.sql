create table public.project_artists (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  artist_id uuid not null references public.artists (id) on delete cascade,
  billing_order int not null default 0,
  created_at timestamptz not null default now(),
  unique (project_id, artist_id)
);

alter table public.project_artists enable row level security;

create policy "project_artists_select_published_or_admin"
  on public.project_artists for select
  to anon, authenticated
  using (
    public.is_admin()
    or exists (
      select 1 from public.projects p
      where p.id = project_id and p.is_published = true
    )
  );

create policy "project_artists_write_admin_only"
  on public.project_artists for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());
