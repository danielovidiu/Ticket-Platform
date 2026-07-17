create table public.gallery_items (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects (id) on delete set null,
  artist_id uuid references public.artists (id) on delete set null,
  media_type text not null check (media_type in ('image', 'video')),
  media_url text not null,
  thumbnail_url text,
  caption text,
  tags text[] not null default '{}',
  is_published boolean not null default false,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

alter table public.gallery_items enable row level security;

create policy "gallery_items_select_published_or_admin"
  on public.gallery_items for select
  to anon, authenticated
  using (is_published = true or public.is_admin());

create policy "gallery_items_write_admin_only"
  on public.gallery_items for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());
