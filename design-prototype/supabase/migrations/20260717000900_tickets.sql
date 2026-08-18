create table public.tickets (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references public.orders (id) on delete cascade,
  ticket_type_id uuid references public.ticket_types (id),
  project_id uuid references public.projects (id),
  owner_user_id uuid references public.profiles (id),
  qr_code_token text unique,
  status text not null default 'valid' check (status in ('valid', 'checked_in', 'void', 'refunded')),
  checked_in_at timestamptz,
  checked_in_by uuid references public.profiles (id),
  holder_name text,
  holder_email text,
  created_at timestamptz not null default now()
);

alter table public.tickets enable row level security;

create policy "tickets_select_own_or_admin"
  on public.tickets for select
  to authenticated
  using (auth.uid() = owner_user_id or public.is_admin());

-- No insert/update policy for anon/authenticated: issuance happens on
-- webhook-confirmed payment and check-in happens at the door, both via
-- service-role Edge Functions in a later slice. Admins can still correct rows
-- by hand from the dashboard.
create policy "tickets_update_admin_only"
  on public.tickets for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());
