export function getMemoryBankCloudContextResource(host, sessionToken, query = {}) {
    const bundle = host.getContextBundle(sessionToken, query);
    return {
        uri: 'memory-bank-cloud://context/current',
        name: 'Memory Bank Cloud Context',
        mimeType: 'application/json',
        text: JSON.stringify(bundle, null, 2),
    };
}
