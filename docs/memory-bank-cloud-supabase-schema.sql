-- Memory Bank Cloud Supabase schema skeleton.
-- This is intentionally credential-free and safe to review locally.
-- Apply only to a dedicated Supabase project after tenant/RLS review.

create extension if not exists pgcrypto;

create table if not exists mbc_tenants (
  id text primary key,
  name text not null,
  plan text not null default 'team',
  created_at timestamptz not null default now()
);

create table if not exists mbc_orgs (
  id text primary key,
  tenant_id text not null references mbc_tenants(id) on delete cascade,
  name text not null,
  parent_org_id text references mbc_orgs(id),
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);

create table if not exists mbc_teams (
  id text primary key,
  tenant_id text not null references mbc_tenants(id) on delete cascade,
  org_id text not null references mbc_orgs(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, org_id, id)
);

create table if not exists mbc_projects (
  id text primary key,
  tenant_id text not null references mbc_tenants(id) on delete cascade,
  org_id text not null references mbc_orgs(id) on delete cascade,
  team_id text not null references mbc_teams(id) on delete cascade,
  slug text not null,
  repo_url text,
  created_at timestamptz not null default now(),
  unique (tenant_id, team_id, id)
);

create table if not exists mbc_users (
  id text primary key,
  tenant_id text not null references mbc_tenants(id) on delete cascade,
  external_subject text,
  email text,
  display_name text,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);

create table if not exists mbc_memberships (
  tenant_id text not null references mbc_tenants(id) on delete cascade,
  user_id text not null references mbc_users(id) on delete cascade,
  scope_type text not null check (scope_type in ('personal','project','team','org','company')),
  scope_id text not null,
  role text not null check (role in ('owner','admin','member','viewer','service')),
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id, scope_type, scope_id)
);

create table if not exists mbc_login_tokens (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references mbc_tenants(id) on delete cascade,
  token_hash text not null unique,
  purpose text not null check (purpose in ('mcp_login','sidecar_enrollment')),
  issuer_tenant_id text not null,
  issuer_user_id text not null,
  issuer_scope_type text not null check (issuer_scope_type in ('personal','project','team','org','company')),
  issuer_scope_id text not null,
  issuer_role text not null check (issuer_role in ('owner','admin','service')),
  org_id text not null,
  team_id text not null,
  project_id text not null,
  user_id text not null,
  source_agent text not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint mbc_login_tokens_issuer_same_tenant check (issuer_tenant_id = tenant_id)
);

create table if not exists mbc_context_entries (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references mbc_tenants(id) on delete cascade,
  org_id text not null,
  team_id text not null,
  project_id text not null,
  user_id text not null,
  scope_type text not null check (scope_type in ('personal','project','team','org','company')),
  scope_id text not null,
  source_agent text not null,
  title text not null,
  body text not null,
  tags text[] not null default '{}',
  sensitivity text not null default 'internal' check (sensitivity in ('public','internal','confidential','restricted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists mbc_context_scope_idx
  on mbc_context_entries (tenant_id, scope_type, scope_id, updated_at desc);

create index if not exists mbc_context_project_idx
  on mbc_context_entries (tenant_id, org_id, team_id, project_id, updated_at desc);

create table if not exists mbc_audit_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references mbc_tenants(id) on delete cascade,
  actor_user_id text not null,
  action text not null,
  target_type text not null,
  target_id text not null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

alter table mbc_tenants enable row level security;
alter table mbc_orgs enable row level security;
alter table mbc_teams enable row level security;
alter table mbc_projects enable row level security;
alter table mbc_users enable row level security;
alter table mbc_memberships enable row level security;
alter table mbc_login_tokens enable row level security;
alter table mbc_context_entries enable row level security;
alter table mbc_audit_events enable row level security;

-- Application/MCP layer should set request.jwt.claims.tenant_id and request.jwt.claims.user_id
-- after validating mbc_login_tokens.token_hash. Service-role migrations bypass RLS.
-- Login-token INSERT is intentionally control-plane only: the private MCP/admin API must
-- validate issuer membership and clip session memberships to issuer_scope before inserting.
-- Do not create broad client-facing INSERT/SELECT policies on mbc_login_tokens.
create or replace function mbc_current_tenant_id()
returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id', '')
$$;

create or replace function mbc_current_user_id()
returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'user_id', '')
$$;

create or replace function mbc_can_read_scope(row_scope_type text, row_scope_id text)
returns boolean language sql stable as $$
  select exists (
    select 1
    from mbc_memberships m
    where m.tenant_id = mbc_current_tenant_id()
      and m.user_id = mbc_current_user_id()
      and m.scope_type = row_scope_type
      and m.scope_id = row_scope_id
  )
$$;

create policy mbc_context_entries_read_visible_scope
  on mbc_context_entries for select
  using (
    tenant_id = mbc_current_tenant_id()
    and mbc_can_read_scope(scope_type, scope_id)
  );

create policy mbc_context_entries_insert_visible_scope
  on mbc_context_entries for insert
  with check (
    tenant_id = mbc_current_tenant_id()
    and user_id = mbc_current_user_id()
    and mbc_can_read_scope(scope_type, scope_id)
  );

create policy mbc_memberships_read_self
  on mbc_memberships for select
  using (tenant_id = mbc_current_tenant_id() and user_id = mbc_current_user_id());

create policy mbc_audit_read_tenant_self
  on mbc_audit_events for select
  using (tenant_id = mbc_current_tenant_id() and actor_user_id = mbc_current_user_id());
