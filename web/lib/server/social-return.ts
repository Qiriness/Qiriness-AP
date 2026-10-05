/**
 * Where a person lands after connecting a provider. A fixed list, never the
 * query string's own value: an open redirect on a login callback is the classic
 * way to hand someone a convincing link to somewhere else.
 *
 * Each entry ends in a query string so the callback can append to it.
 */
const RETURNS: Record<string, string> = {
  social: "/insights/social?connections=1",
  settings: "/settings?tab=integrations",
};

export function returnPath(key: string | null | undefined): string {
  return RETURNS[key ?? ""] ?? RETURNS.social;
}

/** The stored path, if it is one of ours; else the default. */
export function knownReturn(path: unknown): string {
  return Object.values(RETURNS).includes(path as string) ? (path as string) : RETURNS.social;
}
