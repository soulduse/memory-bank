import fs from 'fs';
import { describe, it, expect } from 'vitest';

const sql = fs.readFileSync('supabase/migrations/0001_memory_bank_cloud.sql', 'utf8');

describe('memory-bank-cloud Supabase RLS migration', () => {
  it('enables RLS on every cloud table', () => {
    for (const table of ['mbc_memberships', 'mbc_login_tokens', 'mbc_login_sessions', 'mbc_context_entries', 'mbc_exchanges', 'mbc_facts', 'mbc_audit_events']) {
      expect(sql).toContain(`alter table public.${table} enable row level security`);
    }
  });

  it('denies client-side login token/session access and gates data by tenant visible scope', () => {
    expect(sql).toContain('mbc_login_tokens_deny_client_access');
    expect(sql).toContain('mbc_login_sessions_deny_client_access');
    for (const table of ['context', 'exchanges', 'facts']) {
      expect(sql).toContain(`mbc_${table}_select_visible_scope`);
    }
    expect(sql).toContain('tenant_id = public.mbc_current_tenant()');
    expect(sql).toContain('public.mbc_visible_scope(tenant_id, scope_type, scope_id)');
  });
});
