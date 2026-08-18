create table public.special_links (
  id uuid primary key default gen_random_uuid(),
  token text not null unique,
  project_id uuid references public.projects (id) on delete cascade,
  ticket_type_id uuid references public.ticket_types (id) on delete cascade,
  price_override_cents int,
  max_uses int,
  uses_count int not null default 0,
  expires_at timestamptz,
  created_by uuid references public.profiles (id),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.special_links enable row level security;

-- Admin-only table read. Public resolution of a token (unlocking a hidden
-- ticket type / special price) happens via a future service-role Edge
-- Function, never a direct table read, so the token space can't be enumerated.
create policy "special_links_admin_only"
  on public.special_links for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());
