import type { CheckCache, ProbeHelpers } from "./types";

export type GoogleServiceAccount = { client_email: string; private_key: string; project_id?: string };

/** Parse a service-account JSON key; undefined when it isn't one */
export function parseServiceAccount(json: string | undefined): GoogleServiceAccount | undefined {
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json) as Partial<GoogleServiceAccount>;
    return parsed.client_email && parsed.private_key ? (parsed as GoogleServiceAccount) : undefined;
  } catch {
    return undefined;
  }
}

const base64url = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const encodeJson = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));

function pemToPkcs8(pem: string) {
  const body = pem
    // Keys pasted into environment variables often carry escaped newlines
    .replace(/\\n/g, "\n")
    .replace(/-----BEGIN [^-]+-----|-----END [^-]+-----|\s+/g, "");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** A signed JWT assertion for Google's OAuth token endpoint (RS256, Web Crypto) */
export async function signGoogleAssertion({
  account,
  scope,
  now = Date.now(),
}: {
  account: GoogleServiceAccount;
  scope: string;
  now?: number;
}) {
  const issuedAt = Math.floor(now / 1000);
  const unsigned = `${encodeJson({ alg: "RS256", typ: "JWT" })}.${encodeJson({
    iss: account.client_email,
    scope,
    aud: "https://oauth2.googleapis.com/token",
    iat: issuedAt,
    exp: issuedAt + 3600,
  })}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(account.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64url(new Uint8Array(signature))}`;
}

/**
 * An OAuth access token for a Google service account, without any Google library: it only
 * needs `fetch` and Web Crypto, so it works on edge runtimes. Tokens are cached until
 * shortly before they expire.
 */
export async function googleServiceAccountToken({
  account,
  scope,
  http,
  cache,
  now = Date.now(),
}: {
  account: GoogleServiceAccount;
  scope: string;
  http: ProbeHelpers["http"];
  cache?: CheckCache;
  now?: number;
}): Promise<string> {
  const cacheKey = `google-token:${account.client_email}:${scope}`;
  const cached = await cache?.get(cacheKey);
  if (cached) return cached;

  const assertion = await signGoogleAssertion({ account, scope, now });
  const response = await http("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString(),
  });
  const body = response.json as { access_token?: string; expires_in?: number; error_description?: string; error?: string };
  if (!response.ok || !body?.access_token) {
    throw new Error(
      `Google auth failed: ${body?.error_description ?? body?.error ?? response.outcome.error ?? "no access token"}`
    );
  }
  // Keep a margin so a token never expires mid-check
  const ttlMs = Math.max(60_000, ((body.expires_in ?? 3600) - 300) * 1000);
  await cache?.set(cacheKey, body.access_token, ttlMs);
  return body.access_token;
}
