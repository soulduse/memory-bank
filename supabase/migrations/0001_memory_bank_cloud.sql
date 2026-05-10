create extension if not exists pgcrypto;

create table if not exists public.mbc_memberships (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  user_id text not null,
  scope_type text not null check (scope_type in ('personal','project','team','org','company')),
  scope_id text not null,
  role text not null check (role in ('owner','admin','member','viewer','service')),
  created_at timestamptz not null default now(),
  unique (tenant_id, user_id, scope_type, scope_id)
);

create table if not exists public.mbc_login_tokens (
  id uuid primary key,
  token_hash text not null unique,
  purpose text not null check (purpose in ('mcp_login','sidecar_enrollment')),
  issuer jsonb not null,
  account jsonb not null,
  memberships jsonb not null default '[]'::jsonb,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  revoked_at timestamptz
);

create table if not exists public.mbc_login_sessions (
  session_token text primary key,
  login_id uuid not null,
  account jsonb not null,
  memberships jsonb not null default '[]'::jsonb,
  created_at timestamptz not null,
  expires_at timestamptz not null
);

create table if not exists public.mbc_context_entries (
  id uuid primary key,
  tenant_id text not null,
  scope_type text not null check (scope_type in ('personal','project','team','org','company')),
  scope_id text not null,
  org_id text not null,
  team_id text not null,
  project_id text not null,
  user_id text not null,
  source_agent text not null,
  title text not null,
  body text not null,
  tags jsonb not null default '[]'::jsonb,
  sensitivity text not null check (sensitivity in ('public','internal','confidential','restricted')),
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table if not exists public.mbc_exchanges (
  id uuid primary key,
  tenant_id text not null,
  scope_type text not null check (scope_type in ('personal','project','team','org','company')),
  scope_id text not null,
  org_id text not null,
  team_id text not null,
  project_id text not null,
  user_id text not null,
  source_agent text not null,
  source_id text not null,
  project_path text,
  title text not null,
  content text not null,
  tags jsonb not null default '[]'::jsonb,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table if not exists public.mbc_facts (
  id uuid primary key,
  tenant_id text not null,
  scope_type text not null check (scope_type in ('personal','project','team','org','company')),
  scope_id text not null,
  org_id text not null,
  team_id text not null,
  project_id text not null,
  user_id text not null,
  source_agent text not null,
  category text not null check (category in ('decision','preference','pattern','knowledge','constraint')),
  fact text not null,
  confidence numeric not null check (confidence >= 0 and confidence <= 1),
  source_exchange_id uuid references public.mbc_exchanges(id) on delete set null,
  tags jsonb not null default '[]'::jsonb,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table if not exists public.mbc_audit_events (
  id uuid primary key,
  tenant_id text not null,
  actor_user_id text not null,
  action text not null,
  target_type text not null,
  target_id text not null,
  created_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists mbc_context_tenant_scope_idx on public.mbc_context_entries (tenant_id, scope_type, scope_id, updated_at desc);
create index if not exists mbc_exchanges_tenant_scope_idx on public.mbc_exchanges (tenant_id, scope_type, scope_id, updated_at desc);
create index if not exists mbc_facts_tenant_scope_idx on public.mbc_facts (tenant_id, scope_type, scope_id, updated_at desc);
create index if not exists mbc_audit_tenant_created_idx on public.mbc_audit_events (tenant_id, created_at desc);

create or replace function public.mbc_current_tenant()
returns text language sql stable as $$ select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id', '') $$;

create or replace function public.mbc_current_user_id()
returns text language sql stable as $$ select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'user_id', '') $$;

create or replace function public.mbc_visible_scope(target_tenant text, target_scope_type text, target_scope_id text)
returns boolean language sql stable as $$
  select exists (
    select 1
    from public.mbc_memberships m
    where m.tenant_id = target_tenant
      and m.tenant_id = public.mbc_current_tenant()
      and m.user_id = public.mbc_current_user_id()
      and m.scope_type = target_scope_type
      and m.scope_id = target_scope_id
  )
$$;

alter table public.mbc_memberships enable row level security;
alter table public.mbc_login_tokens enable row level security;
alter table public.mbc_login_sessions enable row level security;
alter table public.mbc_context_entries enable row level security;
alter table public.mbc_exchanges enable row level security;
alter table public.mbc_facts enable row level security;
alter table public.mbc_audit_events enable row level security;

create policy mbc_memberships_self_select on public.mbc_memberships for select
  using (tenant_id = public.mbc_current_tenant() and user_id = public.mbc_current_user_id());

create policy mbc_login_tokens_deny_client_access on public.mbc_login_tokens for all
  using (false)
  with check (false);

create policy mbc_login_sessions_deny_client_access on public.mbc_login_sessions for all
  using (false)
  with check (false);

create policy mbc_context_select_visible_scope on public.mbc_context_entries for select
  using (tenant_id = public.mbc_current_tenant() and public.mbc_visible_scope(tenant_id, scope_type, scope_id));
create policy mbc_context_insert_visible_scope on public.mbc_context_entries for insert
  with check (tenant_id = public.mbc_current_tenant() and public.mbc_visible_scope(tenant_id, scope_type, scope_id));
create policy mbc_context_update_visible_scope on public.mbc_context_entries for update
  using (tenant_id = public.mbc_current_tenant() and public.mbc_visible_scope(tenant_id, scope_type, scope_id))
  with check (tenant_id = public.mbc_current_tenant() and public.mbc_visible_scope(tenant_id, scope_type, scope_id));

create policy mbc_exchanges_select_visible_scope on public.mbc_exchanges for select
  using (tenant_id = public.mbc_current_tenant() and public.mbc_visible_scope(tenant_id, scope_type, scope_id));
create policy mbc_exchanges_insert_visible_scope on public.mbc_exchanges for insert
  with check (tenant_id = public.mbc_current_tenant() and public.mbc_visible_scope(tenant_id, scope_type, scope_id));
create policy mbc_exchanges_update_visible_scope on public.mbc_exchanges for update
  using (tenant_id = public.mbc_current_tenant() and public.mbc_visible_scope(tenant_id, scope_type, scope_id))
  with check (tenant_id = public.mbc_current_tenant() and public.mbc_visible_scope(tenant_id, scope_type, scope_id));

create policy mbc_facts_select_visible_scope on public.mbc_facts for select
  using (tenant_id = public.mbc_current_tenant() and public.mbc_visible_scope(tenant_id, scope_type, scope_id));
create policy mbc_facts_insert_visible_scope on public.mbc_facts for insert
  with check (tenant_id = public.mbc_current_tenant() and public.mbc_visible_scope(tenant_id, scope_type, scope_id));
create policy mbc_facts_update_visible_scope on public.mbc_facts for update
  using (tenant_id = public.mbc_current_tenant() and public.mbc_visible_scope(tenant_id, scope_type, scope_id))
  with check (tenant_id = public.mbc_current_tenant() and public.mbc_visible_scope(tenant_id, scope_type, scope_id));

create policy mbc_audit_select_tenant on public.mbc_audit_events for select
  using (tenant_id = public.mbc_current_tenant());
create policy mbc_audit_insert_tenant on public.mbc_audit_events for insert
  with check (tenant_id = public.mbc_current_tenant());
