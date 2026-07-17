create table public.contact_messages (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  subject text not null,
  message text not null,
  status text not null default 'new' check (status in ('new', 'read', 'archived')),
  ip_hash text,
  user_agent text,
  created_at timestamptz not null default now()
);

alter table public.contact_messages enable row level security;

-- Forces status back to 'new' server-side regardless of client payload, so a
-- malicious insert can't self-mark a message as already read/archived.
create or replace function public.force_contact_message_status_new()
returns trigger
language plpgsql
as $$
begin
  new.status = 'new';
  return new;
end;
$$;

create trigger contact_messages_force_status_new
  before insert on public.contact_messages
  for each row execute function public.force_contact_message_status_new();

create policy "contact_messages_select_admin_only"
  on public.contact_messages for select
  to authenticated
  using (public.is_admin());

-- Public insert-only contact form. CAPTCHA + rate limiting are deferred to a
-- later admin-infra slice; a client-side honeypot field is a stopgap only.
create policy "contact_messages_insert_public"
  on public.contact_messages for insert
  to anon, authenticated
  with check (true);

create policy "contact_messages_update_admin_only"
  on public.contact_messages for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());
