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
export type { AwsCredentialsOptions, BedrockOptions, S3BucketOptions } from "./aws";
export { neon } from "./neon";
export type { NeonProjectOptions } from "./neon";

// Databases
export { mongodb, postgres, redis } from "./databases";
export type { MongoPingOptions, PostgresPingOptions, RedisPingOptions } from "./databases";

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
  elevenlabs,
  emelia,
  exa,
  gemini,
  github,
  gladia,
  googleTranslate,
  mailersend,
  meilisearch,
  mux,
  nimble,
  openai,
  pusher,
  resend,
  revolut,
  signPusherRequest,
  speechmatics,
  statuspage,
  stripe,
  tavily,
  upstashRedis,
  vercel,
} from "./providers";
export type {
  AnthropicOptions,
  AttendeeOptions,
  AxiomOptions,
  AzureTranslatorOptions,
  CloudflareStreamOptions,
  DeepgramOptions,
  DeepLOptions,
  ElevenLabsOptions,
  EmeliaOptions,
  GitHubOptions,
  GoogleTranslateOptions,
  MailerSendOptions,
  MeilisearchOptions,
  MuxOptions,
  OpenAIOptions,
  PusherOptions,
  ResendOptions,
  RevolutOptions,
  SpeechmaticsOptions,
  StatuspageOptions,
  StripeOptions,
  TavilyOptions,
  UpstashRedisOptions,
  VercelAiGatewayOptions,
  VercelBlobOptions,
} from "./providers";
