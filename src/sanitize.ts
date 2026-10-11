const MAX_LENGTH = 300;
const MIN_SECRET_LENGTH = 6;

/** Shapes of well-known credentials, redacted even when the value was never declared as a secret */
const KEY_PATTERNS: RegExp[] = [
  // PEM blocks (private keys, certificates), whole or cut short
  /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(-----END [A-Z0-9 ]+-----|$)/g,
  // JSON Web Tokens (OAuth access and identity tokens)
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(\.[A-Za-z0-9_-]*)?/g,
  // Prefixed API keys: OpenAI/Anthropic/Stripe (sk-, pk_, rk_), GitHub, Slack, Fly, MailerSend.
  // "*" is included because providers echo keys back partly masked (sk-proj-****abcd).
  /\b(sk|pk|rk)[-_][A-Za-z0-9_*.-]{12,}/g,
  /\b(gh[pousr]_|github_pat_)[A-Za-z0-9_*]{12,}/g,
  /\bxox[abeoprs]-[A-Za-z0-9*-]{10,}/g,
  /\b(FlyV1 |fm[12]_|fo1_)[A-Za-z0-9+/=_,*-]{12,}/g,
  /\bmlsn\.[A-Za-z0-9*]{12,}/g,
  // AWS access key ids, Google API keys, Google OAuth tokens
  /\b(AKIA|ASIA)[0-9A-Z*]{12,}/g,
  /\bAIza[0-9A-Za-z_*-]{20,}/g,
  /\bya29\.[0-9A-Za-z_*.-]{12,}/g,
];

/**
 * Every value worth redacting from a set of secrets: the values themselves, the string fields
 * of JSON secrets (e.g. the private key inside a service-account JSON), the user and password
 * of connection strings, and the encoded forms a value takes in URLs, JSON and Basic auth.
 */
export function collectSecretValues(secrets: Iterable<string | undefined>): string[] {
  const values = new Set<string>();
  const addOne = (value: string) => {
    if (value.length >= MIN_SECRET_LENGTH) values.add(value);
  };
  const add = (value: unknown) => {
    if (typeof value !== "string" || value.length < MIN_SECRET_LENGTH) return;
    addOne(value);
    // The same value as it appears in a URL, inside JSON, and base64-encoded
    try {
      addOne(encodeURIComponent(value));
    } catch {
      // Lone surrogates can't be encoded: the raw value is still covered
    }
    addOne(JSON.stringify(value).slice(1, -1));
    try {
      addOne(btoa(value).replace(/=+$/, ""));
    } catch {
      // Not Latin-1: no base64 form to worry about
    }
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
    // Connection strings: drivers report the user or the password on their own
    const credentials = /^[a-z][a-z0-9+.-]*:\/\/([^\s/@:]*):([^\s/@]*)@/i.exec(secret);
    for (const part of credentials?.slice(1) ?? []) {
      add(part);
      try {
        add(decodeURIComponent(part));
      } catch {
        // Not percent-encoded
      }
    }
  }
  // Longest first, so a secret containing another one is fully redacted
  return [...values].sort((a, b) => b.length - a.length);
}

/**
 * Strip secret values, URL credentials, query strings, bearer-like tokens and anything shaped
 * like a well-known credential. Safe for text of any length: nothing is cut here, so a secret
 * can never be half-removed.
 */
export function redactText({ text, secretValues }: { text: string; secretValues: string[] }): string {
  let out = text;
  for (const secret of secretValues) out = out.split(secret).join("***");
  out = out
    // user:pass@host
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1***@")
    // query strings
    .replace(/(\b(?:https?|wss?):\/\/[^\s?]+)\?[^\s"')]*/gi, "$1?***")
    // bearer-ish tokens that slipped through
    .replace(/\b(Bearer|Token|Basic|DeepL-Auth-Key)\s+[A-Za-z0-9._~+/=*-]{8,}/gi, "$1 ***");
  for (const pattern of KEY_PATTERNS) out = out.replace(pattern, "***");
  return out;
}

/** Errors are shown on public pages: redact, then truncate (in that order) */
export function sanitizeError({
  message,
  secretValues,
}: {
  message: string | undefined;
  secretValues: string[];
}): string | undefined {
  if (!message) return undefined;
  const out = redactText({ text: message, secretValues });
  return out.length > MAX_LENGTH ? `${out.slice(0, MAX_LENGTH)}…` : out;
}
