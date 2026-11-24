/**
 * Canonical API root for a direct Chat Completions connection. The Workshop and its optional
 * private-network transport compare these roots exactly before choosing a destination.
 */
export function normalizeModelApiRoot(value: string | undefined): string {
  const raw = value?.trim() ?? "";
  const url = URL.canParse(raw) ? new URL(raw) : undefined;
  if (!url || !/^https?:\/\/[^/]/i.test(raw) || /[\s\p{Cc}\\%?#]/u.test(raw) ||
      url.username || url.password || /@/.test(raw.split("/")[2]) ||
      /\/\.{1,2}(?:\/|$)/.test(raw) || url.pathname.includes("%")) {
    throw new Error("Enter an HTTP or HTTPS API root with a plain path and no credentials, query, or fragment.");
  }
  return url.href.replace(/\/+$/, "");
}
