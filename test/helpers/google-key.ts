/** A real RSA key pair, as a Google service-account JSON key, to exercise signing end to end */
export async function makeServiceAccount({ escapedNewlines = false } = {}) {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const base64 = btoa(String.fromCharCode(...pkcs8));
  const pem = `-----BEGIN PRIVATE KEY-----\n${base64.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
  const account = {
    type: "service_account",
    project_id: "line21-test",
    client_email: "status@line21-test.iam.gserviceaccount.com",
    private_key: escapedNewlines ? pem.replace(/\n/g, "\\n") : pem,
  };
  return { account, json: JSON.stringify(account), publicKey: pair.publicKey };
}

export function decodeJwt(token: string) {
  const [header, payload, signature] = token.split(".") as [string, string, string];
  const decode = (part: string) => atob(part.replace(/-/g, "+").replace(/_/g, "/"));
  return {
    header: JSON.parse(decode(header)) as Record<string, unknown>,
    payload: JSON.parse(decode(payload)) as Record<string, unknown>,
    signed: new TextEncoder().encode(`${header}.${payload}`),
    signature: Uint8Array.from(decode(signature), (char) => char.charCodeAt(0)),
  };
}
