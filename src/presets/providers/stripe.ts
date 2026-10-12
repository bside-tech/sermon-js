import { definePreset, type PresetOptions } from "../../config";
import type { CheckOutcome, Instance, Metrics } from "../../types";
import { bearer } from "./shared";

export type StripeOptions = PresetOptions & {
  /** A secret or restricted key. Restricted keys need read access to what you track. */
  secrets: { apiKey: string | undefined };
  track?: {
    /** Warn when a live account can't take charges or payouts, or has overdue requirements (default true) */
    account?: boolean;
    /** Report each webhook endpoint, and events Stripe could not deliver in the last 24 h (default true) */
    webhooks?: boolean;
    /** Count disputes awaiting your response (default true) */
    disputes?: boolean;
  };
};

type Money = { amount: number; currency: string };
type Balance = { livemode?: boolean; available?: Money[]; pending?: Money[] };
type Account = {
  charges_enabled?: boolean;
  payouts_enabled?: boolean;
  requirements?: { past_due?: string[]; disabled_reason?: string | null };
};
type List<T> = { data?: T[]; has_more?: boolean };

const API = "https://api.stripe.com/v1";
const DAY_S = 24 * 60 * 60;
const ZERO_DECIMAL = new Set(["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"]);

function money(amounts: Money[] | undefined) {
  return (amounts ?? [])
    .slice(0, 3)
    .map(({ amount, currency }) => {
      const value = ZERO_DECIMAL.has(currency) ? String(amount) : (amount / 100).toFixed(2);
      return `${value} ${currency.toUpperCase()}`;
    })
    .join(", ");
}

/** Host and path identify an endpoint across re-creations, without its query string */
function endpointKey(url: string) {
  try {
    const { host, pathname } = new URL(url);
    return `${host}${pathname}`;
  } catch {
    return "endpoint";
  }
}

const count = (list: List<unknown>) => `${list.data?.length ?? 0}${list.has_more ? "+" : ""}`;

/**
 * Stripe. Reads the balance, which validates the key, then what `track` asks for. All calls
 * are free and read-only.
 * - up: the key works
 * - degraded: a webhook endpoint is disabled, Stripe could not deliver events in the last
 *   24 h, or a live account can't take charges or payouts or has overdue requirements
 * - down: the API rejects the key or errors
 *
 * Reports `metrics.mode` (live/test), `metrics.available`, `metrics.pending`,
 * `metrics.undelivered24h`, `metrics.openDisputes`, and one `instances` row per webhook
 * endpoint. What a restricted key may not read is left out, never counted as a failure.
 */
export const stripe = definePreset<StripeOptions>()({
  kind: "stripe",
  requiredSecrets: ["apiKey"],
  derive: () => ({ name: "Stripe", identity: "stripe", description: "Reads the balance, account and webhook endpoints" }),
  check: async ({ options, secrets, http, now }): Promise<CheckOutcome> => {
    const { account = true, webhooks = true, disputes = true } = options.track ?? {};
    const get = (path: string) => http(`${API}${path}`, { headers: bearer(secrets.apiKey) });
    const skip = Promise.resolve(undefined);

    const [balance, accountRes, endpoints, undelivered, disputeList] = await Promise.all([
      get("/balance"),
      account ? get("/account") : skip,
      webhooks ? get("/webhook_endpoints?limit=100") : skip,
      webhooks ? get(`/events?delivery_success=false&limit=100&created[gte]=${Math.floor(now / 1000) - DAY_S}`) : skip,
      disputes ? get("/disputes?limit=100") : skip,
    ]);

    // 403: a restricted key without balance access is still a working key
    if (!balance.ok && balance.status !== 403) return balance.outcome;
    const metrics: Metrics = {};
    const warnings: string[] = [];
    const funds = balance.ok ? (balance.json as Balance) : undefined;
    if (funds) {
      metrics.mode = funds.livemode ? "live" : "test";
      if (funds.available?.length) metrics.available = money(funds.available);
      if (funds.pending?.length) metrics.pending = money(funds.pending);
    } else {
      metrics.key = "restricted";
    }

    // Test-mode accounts are often not activated: only a live account is held to these
    if (accountRes?.ok && funds?.livemode) {
      const body = accountRes.json as Account;
      if (body.charges_enabled === false) warnings.push("Charges are disabled");
      if (body.payouts_enabled === false) warnings.push("Payouts are disabled");
      const overdue = body.requirements?.past_due?.length ?? 0;
      if (overdue > 0) warnings.push(`${overdue} account requirement(s) past due`);
    }

    let instances: Instance[] | undefined;
    if (endpoints?.ok) {
      const list = (endpoints.json as List<{ id: string; url: string; status: string }>).data ?? [];
      const seen = new Set<string>();
      instances = list.map((endpoint) => {
        let key = endpointKey(endpoint.url);
        for (let n = 2; seen.has(key); n++) key = `${endpointKey(endpoint.url)}#${n}`;
        seen.add(key);
        const enabled = endpoint.status === "enabled";
        return { key, id: endpoint.id, state: endpoint.status, status: enabled ? "up" : "down", error: enabled ? undefined : "Endpoint disabled" };
      });
      metrics.webhookEndpoints = list.length;
      const disabled = instances.filter((instance) => instance.status === "down").length;
      if (disabled > 0) warnings.push(`${disabled} webhook endpoint(s) disabled`);
    }
    if (undelivered?.ok) {
      const list = undelivered.json as List<unknown>;
      metrics.undelivered24h = count(list);
      if (list.data?.length) warnings.push(`${count(list)} event(s) not delivered in the last 24 h`);
    }
    if (disputeList?.ok) {
      const open = ((disputeList.json as List<{ status: string }>).data ?? []).filter((dispute) =>
        dispute.status.endsWith("needs_response")
      );
      metrics.openDisputes = open.length;
    }

    return {
      status: warnings.length ? "degraded" : "up",
      latencyMs: balance.latencyMs,
      httpStatus: balance.status,
      error: warnings.join("; ") || undefined,
      metrics,
      instances: instances?.length ? instances : undefined,
      instanceLabels: { key: "Webhook endpoint", detail: "ID" },
    };
  },
});
