create table public.discount_codes (
  id uuid primary key default gen_random_uuid(),
  code citext not null unique,
  description text,
  discount_type text not null check (discount_type in ('percent', 'fixed')),
  discount_value numeric not null check (discount_value >= 0),
  max_uses int,
  uses_count int not null default 0,
  valid_from timestamptz,
  valid_until timestamptz,
  scope text not null default 'global' check (scope in ('global', 'event', 'ticket_type')),
  scope_ref uuid,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.discount_codes enable row level security;

-- Never read directly by the client; validation happens through a future
-- Edge Function so a code's discount value/limits are never exposed to anon.
create policy "discount_codes_admin_only"
  on public.discount_codes for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());
