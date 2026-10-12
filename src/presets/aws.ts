import { AwsClient } from "aws4fetch";
import { definePreset, type PresetOptions, type ServiceDefinition } from "../config";
import type { CheckOutcome, Instance, ProbeHelpers } from "../types";
import { bearer, summarize } from "./providers/shared";

type AwsSecrets = { accessKeyId: string | undefined; secretAccessKey: string | undefined };

/** Sign with SigV4, then send through the check's timed `http` helper */
async function signedCall({
  http,
  secrets,
  service,
  region,
  url,
  init,
}: {
  http: ProbeHelpers["http"];
  secrets: { accessKeyId: string; secretAccessKey: string };
  service: string;
  region: string;
  url: string;
  init: { method: string; headers?: Record<string, string>; body?: string };
}) {
  const client = new AwsClient({ ...secrets, service, region });
  const request = await client.sign(url, init);
  return http(request.url, {
    method: init.method,
    headers: Object.fromEntries(request.headers.entries()),
    body: init.body,
  });
}

export type AwsCredentialsOptions = PresetOptions & {
  /** How to call it: these credentials usually belong to one AWS service you use */
  name: string;
  secrets: AwsSecrets;
};

/**
 * AWS credentials, validated with STS `GetCallerIdentity` (free, needs no permission).
 * It only proves the credentials work, not that a particular AWS service is healthy:
 * use it for services with no cheap probe of their own (e.g. Transcribe streaming).
 */
const credentials = definePreset<AwsCredentialsOptions>()({
  kind: "aws.credentials",
  requiredSecrets: ["accessKeyId", "secretAccessKey"],
  derive: (options) => ({
    name: options.name,
    description: "Validates the credentials only (STS GetCallerIdentity)",
  }),
  check: async ({ secrets, http }) => {
    const body = "Action=GetCallerIdentity&Version=2011-06-15";
    const response = await signedCall({
      http,
      secrets,
      service: "sts",
      region: "us-east-1",
      url: "https://sts.amazonaws.com/",
      init: { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body },
    });
    return response.outcome;
  },
});

export type S3BucketOptions = PresetOptions & {
  bucket: string | undefined;
  /** S3-compatible endpoint (Tigris, R2, MinIO…). Default: AWS S3 in `region`. */
  endpoint?: string;
  /** Region (default "us-east-1"; S3-compatible services often use "auto") */
  region?: string;
  secrets: AwsSecrets;
};

/**
 * An S3 bucket, on AWS or any S3-compatible storage (Tigris, Cloudflare R2, MinIO…).
 * Sends `HeadBucket`: up when the bucket is reachable with these credentials, down when it is
 * missing or access is denied.
 */
const s3Bucket = definePreset<S3BucketOptions>()({
  kind: "aws.s3-bucket",
  requiredFields: ["bucket"],
  requiredSecrets: ["accessKeyId", "secretAccessKey"],
  defaults: { slowMs: 1500 },
  derive: (options) => ({
    name: options.bucket ?? "",
    description: "S3 HeadBucket on the storage endpoint",
  }),
  check: async ({ options, secrets, http }) => {
    const region = options.region ?? "us-east-1";
    const endpoint = (options.endpoint ?? `https://s3.${region}.amazonaws.com`).replace(/\/+$/, "");
    const response = await signedCall({
      http,
      secrets,
      service: "s3",
      region,
      url: `${endpoint}/${options.bucket}`,
      init: { method: "HEAD" },
    });
    return response.outcome;
  },
});

export type BedrockOptions = PresetOptions & {
  /** AWS region of the Bedrock runtime, e.g. "eu-west-1" */
  region: string | undefined;
  /**
   * The models you invoke, as the runtime expects them: a model ID or an inference profile
   * ID ("eu.anthropic.claude-haiku-4-5-20251001-v1:0"). Each one is reported on its own row.
   */
  models: string[];
  /** A Bedrock API key (`bearerToken`), or an access key pair */
  secrets: {
    bearerToken?: string | undefined;
    accessKeyId?: string | undefined;
    secretAccessKey?: string | undefined;
  };
};

/** The smallest request each model family accepts */
function pingBody(model: string) {
  if (/(^|\.)cohere\.embed/.test(model)) return { texts: ["ping"], input_type: "search_query" };
  return { anthropic_version: "bedrock-2023-05-31", max_tokens: 1, messages: [{ role: "user", content: "ping" }] };
}

const bedrockPreset = definePreset<BedrockOptions>()({
  kind: "aws.bedrock",
  requiredFields: ["region"],
  requiredSecrets: "all",
  defaults: { slowMs: 5000, timeoutMs: 20_000 },
  derive: () => ({
    name: "Amazon Bedrock",
    identity: "aws.bedrock",
    description: "Invokes each monitored model with one token",
  }),
  check: async ({ options, secrets, http }): Promise<CheckOutcome> => {
    const signer =
      secrets.accessKeyId && secrets.secretAccessKey
        ? new AwsClient({
            accessKeyId: secrets.accessKeyId,
            secretAccessKey: secrets.secretAccessKey,
            service: "bedrock",
            region: options.region,
          })
        : undefined;

    const invoke = async (model: string) => {
      const url = `https://bedrock-runtime.${options.region}.amazonaws.com/model/${encodeURIComponent(model)}/invoke`;
      const init = {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(pingBody(model)),
      };
      if (!signer) return http(url, { ...init, headers: { ...init.headers, ...bearer(secrets.bearerToken ?? "") } });
      const signed = await signer.sign(url, init);
      return http(signed.url, { ...init, headers: Object.fromEntries(signed.headers.entries()) });
    };

    const instances = await Promise.all(
      [...new Set(options.models)].map(async (model): Promise<Instance> => {
        const res = await invoke(model);
        return {
          key: model,
          status: res.outcome.status,
          latencyMs: res.status === undefined ? undefined : res.latencyMs,
          httpStatus: res.status,
          error: res.outcome.error,
        };
      })
    );
    return { ...summarize(instances, "model"), instances, instanceLabels: { key: "Model" } };
  },
});

/**
 * Amazon Bedrock. Invokes each model in `models` with a one-token request (the runtime has
 * no free call that proves a model can be invoked).
 * - up: every model answers
 * - degraded: some models fail, or one is throttled (HTTP 429)
 * - down: every model fails (wrong credentials, no access, wrong region)
 *
 * Reports one `instances` row per model. Authenticates with a Bedrock API key when
 * `secrets.bearerToken` is given, otherwise signs with the access key pair (SigV4).
 */
function bedrock(options: BedrockOptions): ServiceDefinition {
  const { bearerToken, accessKeyId, secretAccessKey } = options.secrets;
  // Only the credentials in use are required: the other kind may stay unset
  return bedrockPreset({ ...options, secrets: bearerToken ? { bearerToken } : { accessKeyId, secretAccessKey } });
}

/** Presets for AWS and S3-compatible storage */
export const aws = { credentials, s3Bucket, bedrock };
