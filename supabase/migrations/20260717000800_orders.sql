create table public.orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles (id),
  project_id uuid references public.projects (id),
  status text not null default 'pending'
    check (status in ('pending', 'reserved', 'paid', 'cancelled', 'refunded', 'expired')),
  currency text not null default 'RON',
  subtotal_cents int,
  discount_cents int not null default 0,
  total_cents int,
  discount_code_id uuid references public.discount_codes (id),
  special_link_id uuid references public.special_links (id),
  stripe_checkout_session_id text,
  stripe_payment_intent_id text,
  invoice_number text,
  invoice_provider text,
  buyer_email text,
  buyer_name text,
  buyer_phone text,
  reserved_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.orders enable row level security;

create trigger orders_set_updated_at
  before update on public.orders
  for each row execute function public.set_updated_at();

create policy "orders_select_own_or_admin"
  on public.orders for select
  to authenticated
  using (auth.uid() = user_id or public.is_admin());

-- Defined for forward-compat with the future ticketing slice; nothing in this
-- slice's UI exercises it. Real order creation will run through a service-role
-- Edge Function so stock reservation stays atomic and can't be spoofed.
create policy "orders_insert_own"
  on public.orders for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "orders_update_admin_only"
  on public.orders for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());
