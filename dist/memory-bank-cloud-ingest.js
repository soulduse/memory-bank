export function ingestCloudExchange(host, sessionToken, input) {
    return host.ingestExchange(sessionToken, input);
}
export function ingestCloudExchangeJsonl(host, sessionToken, jsonl, defaults) {
    const exchanges = [];
    let skipped = 0;
    for (const line of jsonl.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        try {
            const parsed = JSON.parse(trimmed);
            exchanges.push(host.ingestExchange(sessionToken, {
                ...defaults,
                scopeType: parsed.scopeType ?? defaults.scopeType,
                scopeId: parsed.scopeId ?? defaults.scopeId,
                title: parsed.title ?? parsed.sourceId ?? 'Cloud memory exchange',
                content: parsed.content ?? parsed.message ?? parsed.text ?? trimmed,
                sourceId: parsed.sourceId,
                projectPath: parsed.projectPath ?? defaults.projectPath,
                tags: parsed.tags ?? defaults.tags,
                createdAt: parsed.createdAt,
            }));
        }
        catch {
            skipped += 1;
        }
    }
    return { exchanges, skipped };
}
