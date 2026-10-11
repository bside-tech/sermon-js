import { useEffect, useState } from "react";

export type ThemePreference = "system" | "light" | "dark";

const STORAGE_KEY = "sermon:theme";

function readPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

const prefersDark = () =>
  typeof window !== "undefined" && (window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);

/** Apply a preference the way HeroUI and Tailwind expect: `dark` class and `data-theme` on <html> */
export function applyTheme(preference: ThemePreference = readPreference()) {
  if (typeof document === "undefined") return;
  const theme = preference === "system" ? (prefersDark() ? "dark" : "light") : preference;
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

/** The viewer's theme choice (system, light or dark), remembered in their browser */
export function useThemePreference() {
  const [preference, setPreference] = useState<ThemePreference>(readPreference);

  useEffect(() => {
    applyTheme(preference);
    try {
      if (preference === "system") localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, preference);
    } catch {
      // Storage unavailable: the choice lasts for this page view only
    }
    if (preference !== "system") return;
    // Follow the system setting live while it is the choice
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    media?.addEventListener("change", onChange);
    return () => media?.removeEventListener("change", onChange);
  }, [preference]);

  return [preference, setPreference] as const;
}
