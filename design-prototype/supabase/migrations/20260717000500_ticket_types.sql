create table public.ticket_types (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  name text not null,
  price_cents int not null check (price_cents >= 0),
  currency text not null default 'RON',
  wave_order int not null default 0,
  quantity_total int,
  quantity_sold int not null default 0,
  sales_start_at timestamptz,
  sales_end_at timestamptz,
  access_valid_from timestamptz,
  access_valid_until timestamptz,
  max_per_user int,
  is_private boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.ticket_types enable row level security;

create trigger ticket_types_set_updated_at
  before update on public.ticket_types
  for each row execute function public.set_updated_at();

-- Public can see pricing/wave info for published, non-private ticket types even
-- though checkout isn't live yet. Private/invite-only types stay hidden from
-- direct table reads; resolving a special-link token happens through a future
-- service-role Edge Function, never a client-side query.
create policy "ticket_types_select_public_or_admin"
  on public.ticket_types for select
  to anon, authenticated
  using (
    public.is_admin()
    or (
      is_private = false
      and exists (
        select 1 from public.projects p
        where p.id = project_id and p.is_published = true
      )
    )
  );

-- All writes (including stock decrement) go through a service-role Edge
-- Function in the future ticketing slice, bypassing RLS entirely; only admins
-- can write directly via the dashboard in the meantime.
create policy "ticket_types_write_admin_only"
  on public.ticket_types for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());
