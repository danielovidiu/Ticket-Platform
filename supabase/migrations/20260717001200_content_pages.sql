-- Admin-editable rich-text pages: Mission ('mission') plus the three legal
-- pages ('privacy-policy', 'terms-of-sale', 'cookie-policy'). Not part of the
-- original 11-table data model, but needed to make "editable in admin" true
-- for content that would otherwise be hardcoded in the frontend.
create table public.content_pages (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  excerpt text,
  body text not null,
  hero_image_url text,
  is_published boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.content_pages enable row level security;

create trigger content_pages_set_updated_at
  before update on public.content_pages
  for each row execute function public.set_updated_at();

create policy "content_pages_select_published_or_admin"
  on public.content_pages for select
  to anon, authenticated
  using (is_published = true or public.is_admin());

create policy "content_pages_write_admin_only"
  on public.content_pages for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());
