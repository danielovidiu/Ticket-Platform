create table public.artists (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  photo_url text,
  bio text,
  role text,
  genre text,
  links jsonb not null default '[]'::jsonb,
  is_featured boolean not null default false,
  is_published boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.artists enable row level security;

create trigger artists_set_updated_at
  before update on public.artists
  for each row execute function public.set_updated_at();

create policy "artists_select_published_or_admin"
  on public.artists for select
  to anon, authenticated
  using (is_published = true or public.is_admin());

create policy "artists_write_admin_only"
  on public.artists for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());
