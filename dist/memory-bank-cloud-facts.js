export function putCloudFact(host, sessionToken, input) {
    return host.putFact(sessionToken, input);
}
export function searchCloudFacts(host, sessionToken, query) {
    return host.searchFacts(sessionToken, query);
}
