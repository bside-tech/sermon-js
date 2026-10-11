import type { Tone } from "../format";

// Tailwind classes for each tone, using HeroUI's theme colors. Written out in full so
// Tailwind finds them when it scans this package.
export const TONE_BG: Record<Tone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  accent: "bg-accent",
  default: "bg-default",
};

export const TONE_TEXT: Record<Tone, string> = {
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  accent: "text-accent",
  default: "text-muted",
};
