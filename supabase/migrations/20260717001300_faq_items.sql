-- Structured Q&A, not freeform content, so it gets its own table rather than
-- being crammed into content_pages.
create table public.faq_items (
  id uuid primary key default gen_random_uuid(),
  question text not null,
  answer text not null,
  sort_order int not null default 0,
  is_published boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.faq_items enable row level security;

create trigger faq_items_set_updated_at
  before update on public.faq_items
  for each row execute function public.set_updated_at();

create policy "faq_items_select_published_or_admin"
  on public.faq_items for select
  to anon, authenticated
  using (is_published = true or public.is_admin());

create policy "faq_items_write_admin_only"
  on public.faq_items for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());
