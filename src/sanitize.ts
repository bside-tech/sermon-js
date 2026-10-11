const MAX_LENGTH = 300;
const MIN_SECRET_LENGTH = 6;

/**
 * Every value worth redacting from a set of secrets: the values themselves, plus the string
 * fields of JSON secrets (e.g. the private key inside a service-account JSON).
 */
export function collectSecretValues(secrets: Iterable<string | undefined>): string[] {
  const values = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" && value.length >= MIN_SECRET_LENGTH) values.add(value);
  };
  const walk = (value: unknown) => {
    if (typeof value === "string") add(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  for (const secret of secrets) {
    if (!secret) continue;
    add(secret);
    if (secret.trimStart().startsWith("{")) {
      try {
        walk(JSON.parse(secret));
      } catch {
        // Not JSON: the whole value is already covered
      }
    }
  }
  // Longest first, so a secret containing another one is fully redacted
  return [...values].sort((a, b) => b.length - a.length);
}

/**
 * Errors are shown on public pages: strip secret values, URL credentials, query strings
 * and bearer-like tokens, then truncate.
 */
export function sanitizeError({
  message,
  secretValues,
}: {
  message: string | undefined;
  secretValues: string[];
}): string | undefined {
  if (!message) return undefined;
  let out = message;
  for (const secret of secretValues) out = out.split(secret).join("***");
  out = out
    // user:pass@host
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1***@")
    // query strings
    .replace(/(\bhttps?:\/\/[^\s?]+)\?[^\s"')]*/gi, "$1?***")
    // bearer-ish tokens that slipped through
    .replace(/\b(Bearer|Token|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, "$1 ***");
  return out.length > MAX_LENGTH ? `${out.slice(0, MAX_LENGTH)}…` : out;
}
