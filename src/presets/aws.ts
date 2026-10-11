import { AwsClient } from "aws4fetch";
import { definePreset, type PresetOptions } from "../config";
import type { ProbeHelpers } from "../types";

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

/** Presets for AWS and S3-compatible storage */
export const aws = { credentials, s3Bucket };
