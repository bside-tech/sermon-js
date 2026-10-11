// Every preset, in one place. They only use `fetch` and Web Crypto (database presets take a
// client you provide), so this entry works on any runtime, and bundlers drop what you don't use.

export { generic } from "./generic";
export type { GenericHttpOptions } from "./generic";

// Platforms
export { crashReason, fly } from "./fly";
export type { FlyAppOptions } from "./fly";
export { clearGoogleTokens, gcp, googleServiceAccountToken, parseServiceAccount, signGoogleAssertion } from "./gcp";
export type { GcpInstanceOptions, GoogleServiceAccount } from "./gcp";
export { aws } from "./aws";
export type { AwsCredentialsOptions, S3BucketOptions } from "./aws";

// Databases
export { mongodb, redis } from "./databases";
export type { MongoPingOptions, RedisPingOptions } from "./databases";

// Providers
export {
  anthropic,
  attendee,
  axiom,
  azureTranslator,
  cambai,
  cloudflareStream,
  deepgram,
  deepl,
  gemini,
  github,
  gladia,
  googleTranslate,
  mailersend,
  mux,
  openai,
  pusher,
  revolut,
  signPusherRequest,
  speechmatics,
  statuspage,
  upstashRedis,
} from "./providers";
export type {
  AttendeeOptions,
  AxiomOptions,
  AzureTranslatorOptions,
  CloudflareStreamOptions,
  DeepgramOptions,
  DeepLOptions,
  GitHubOptions,
  GoogleTranslateOptions,
  MailerSendOptions,
  MuxOptions,
  OpenAIOptions,
  PusherOptions,
  RevolutOptions,
  SpeechmaticsOptions,
  StatuspageOptions,
  UpstashRedisOptions,
} from "./providers";
