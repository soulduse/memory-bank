/**
 * Call Haiku via Claude Agent SDK (no API key needed inside Claude Code).
 * Fallback chain: Agent SDK → Claude Code CLI → Direct Anthropic SDK.
 */
export declare function callHaiku(systemPrompt: string, userMessage: string, maxTokens?: number): Promise<string>;
export declare function parseJsonResponse<T>(text: string): T | null;
