export function loadMemoryBankCloudConfig(env = process.env) {
    const supabaseUrl = firstNonEmpty(env.MEMORY_BANK_CLOUD_SUPABASE_URL, env.SUPABASE_URL);
    const supabasePrivilegedToken = firstNonEmpty(env.MEMORY_BANK_CLOUD_SUPABASE_TOKEN, env.SUPABASE_SERVICE_ROLE_TOKEN);
    const mode = supabaseUrl && supabasePrivilegedToken ? 'supabase' : 'memory';
    return {
        mode,
        supabaseUrl,
        supabasePrivilegedToken,
        includeAdminTools: env.MEMORY_BANK_CLOUD_ADMIN_TOOLS === '1' || env.MEMORY_BANK_CLOUD_ADMIN_TOOLS === 'true',
        tenantHeaderName: firstNonEmpty(env.MEMORY_BANK_CLOUD_TENANT_HEADER, 'x-memory-bank-cloud-tenant') ?? 'x-memory-bank-cloud-tenant',
    };
}
function firstNonEmpty(...values) {
    return values.find((value) => value !== undefined && value.trim().length > 0);
}
