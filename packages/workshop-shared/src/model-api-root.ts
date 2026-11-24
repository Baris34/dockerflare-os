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

/** Parse the operator's JSON array into the canonical roots allowed for private model traffic. */
export function configuredModelApiRoots(setting: string | undefined): string[] {
  let values: unknown;
  try {
    values = JSON.parse(setting ?? "[]");
  } catch {
    throw new Error("SELF_HOSTED_MODEL_BASE_URLS must be a JSON array of API roots.");
  }
  if (!Array.isArray(values) || !values.every(value => typeof value === "string")) {
    throw new Error("SELF_HOSTED_MODEL_BASE_URLS must be a JSON array of API roots.");
  }
  return [...new Set(values.map(normalizeModelApiRoot))];
}
