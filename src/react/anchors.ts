export const serviceAnchor = (key: string) => `service-${key}`;
export const groupAnchor = (key: string) => `group-${key}`;

/** Fired when navigating to a service or a group: its section expands before we scroll */
export const FOCUS_EVENT = "sermon:focus";
export type FocusDetail = { anchor: string };

/**
 * Navigate to a service or group on the page: update the URL hash, let collapsed sections
 * open, then scroll to it and briefly highlight it.
 */
export function focusAnchor(anchor: string, { smooth = true }: { smooth?: boolean } = {}) {
  history.replaceState(null, "", `#${encodeURIComponent(anchor)}`);
  window.dispatchEvent(new CustomEvent<FocusDetail>(FOCUS_EVENT, { detail: { anchor } }));
  // Give React a tick to render the section expanded before measuring positions.
  // (setTimeout, not requestAnimationFrame: rAF doesn't run while the tab is hidden)
  setTimeout(() => {
    const target = document.getElementById(anchor);
    if (!target) return;
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    target.scrollIntoView?.({ behavior: smooth && !reduceMotion ? "smooth" : "auto", block: "start" });
    if (anchor.startsWith("service-") && !reduceMotion) {
      target.animate?.(
        [
          { backgroundColor: "color-mix(in oklch, var(--accent) 14%, transparent)" },
          { backgroundColor: "transparent" },
        ],
        { duration: 1600, easing: "ease-out" }
      );
    }
  }, 50);
}

/** The anchor in the current URL, if any */
export function currentAnchor(): string | undefined {
  const hash = window.location.hash.slice(1);
  if (!hash) return undefined;
  try {
    return decodeURIComponent(hash);
  } catch {
    return hash;
  }
}
