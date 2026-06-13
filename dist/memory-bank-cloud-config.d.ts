export interface MemoryBankCloudConfig {
    mode: 'memory' | 'supabase';
    supabaseUrl?: string;
    supabasePrivilegedToken?: string;
    includeAdminTools: boolean;
    tenantHeaderName: string;
}
export declare function loadMemoryBankCloudConfig(env?: NodeJS.ProcessEnv): MemoryBankCloudConfig;
