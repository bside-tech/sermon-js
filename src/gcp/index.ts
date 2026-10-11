import { definePreset, type PresetOptions } from "../config";
import { googleServiceAccountToken, parseServiceAccount } from "../google-auth";
import type { CheckOutcome } from "../types";

export { googleServiceAccountToken, parseServiceAccount, signGoogleAssertion } from "../google-auth";
export type { GoogleServiceAccount } from "../google-auth";

export type GcpInstanceOptions = PresetOptions & {
  /** The Compute Engine instance name */
  instance: string | undefined;
  /** Its zone, e.g. "europe-west1-b" */
  zone: string | undefined;
  /** The project ID (default: the one in the service-account key) */
  project?: string;
  secrets: {
    /** Service-account JSON key allowed to read instances (e.g. Compute Viewer) */
    serviceAccount: string | undefined;
  };
  track?: {
    /** URL probed only while the VM is RUNNING. Any HTTP answer counts as healthy. */
    health?: string | false;
  };
};

const SLEEP_STATES = new Set(["TERMINATED", "STOPPED", "SUSPENDED", "STOPPING", "SUSPENDING"]);
const BOOTING_STATES = new Set(["PROVISIONING", "STAGING"]);

/**
 * A Compute Engine VM, checked without ever starting it: the instance status comes from the
 * Compute API, and the optional health URL is only called while the VM is RUNNING.
 * - up: RUNNING (and the health URL answers)
 * - sleeping: TERMINATED, STOPPED or SUSPENDED
 * - degraded: PROVISIONING / STAGING, or slow
 * - down: the Compute API fails, the health URL fails, or the state is unexpected
 *
 * Reports `metrics.vm` and `metrics.zone`.
 */
const instance = definePreset<GcpInstanceOptions>()({
  kind: "gcp.instance",
  requiredFields: ["instance", "zone"],
  requiredSecrets: ["serviceAccount"],
  defaults: { slowMs: 1500 },
  derive: (options) => ({
    name: options.instance ?? "",
    identity: `gcp.instance:${options.project ?? ""}/${options.zone ?? ""}/${options.instance ?? ""}`,
    description: `Google Cloud VM "${options.instance}": status, then health only when running`,
  }),
  check: async ({ options, secrets, http, cache, now }): Promise<CheckOutcome> => {
    const account = parseServiceAccount(secrets.serviceAccount);
    const project = options.project ?? account?.project_id;
    if (!account || !project) {
      return { status: "down", probed: false, error: "The service account secret is not a service-account JSON key" };
    }

    let token: string;
    try {
      token = await googleServiceAccountToken({
        account,
        scope: "https://www.googleapis.com/auth/compute.readonly",
        http,
        cache,
        now,
      });
    } catch (error) {
      return { status: "down", probed: false, error: error instanceof Error ? error.message : String(error) };
    }

    const info = await http(
      `https://compute.googleapis.com/compute/v1/projects/${project}/zones/${options.zone}/instances/${options.instance}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const state = (info.json as { status?: string })?.status;
    if (!info.ok || !state) {
      return {
        status: "down",
        probed: false,
        httpStatus: info.status,
        error: `Compute API: ${info.outcome.error ?? "no instance status"}`,
      };
    }

    const metrics = { vm: state, zone: options.zone as string };
    if (SLEEP_STATES.has(state)) return { status: "sleeping", probed: false, metrics };
    if (BOOTING_STATES.has(state)) return { status: "degraded", probed: false, metrics, error: `VM is ${state}` };
    if (state !== "RUNNING") return { status: "down", probed: false, metrics, error: `VM is ${state}` };

    const health = options.track?.health;
    if (!health) return { status: "up", probed: false, metrics };
    // Any HTTP answer means the host is serving
    const probe = await http(health, { okStatuses: [400, 401, 403, 404, 405] });
    return { ...probe.outcome, metrics };
  },
});

/** Presets for Google Cloud */
export const gcp = { instance };
