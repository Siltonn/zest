"use client";

import { useEffect, useState } from "react";

/**
 * Theme selection.
 *
 * Three states, not two: "system" is the honest default, because most people
 * have already told their OS what they want. An explicit light or dark choice
 * is remembered; system follows the OS and keeps following it if it changes.
 *
 * The class is applied to <html> to match how HeroUI keys its dark tokens, and
 * the same rule runs before first paint in layout.tsx so there is no flash.
 */

export type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "zest-theme";

function apply(theme: Theme): void {
  const dark =
    theme === "dark" ||
    (theme === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

export function useTheme(): {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  resolved: "light" | "dark";
} {
  const [theme, setThemeState] = useState<Theme>("system");
  const [resolved, setResolved] = useState<"light" | "dark">("light");

  useEffect(() => {
    const stored = (localStorage.getItem(STORAGE_KEY) as Theme | null) ?? "system";
    setThemeState(stored);
    apply(stored);
    setResolved(document.documentElement.classList.contains("dark") ? "dark" : "light");

    // Only follow the OS while the user has not made a choice of their own.
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      const current =
        (localStorage.getItem(STORAGE_KEY) as Theme | null) ?? "system";
      if (current !== "system") return;
      apply("system");
      setResolved(media.matches ? "dark" : "light");
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  const setTheme = (next: Theme) => {
    setThemeState(next);
    if (next === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, next);
    apply(next);
    setResolved(
      document.documentElement.classList.contains("dark") ? "dark" : "light",
    );
  };

  return { theme, setTheme, resolved };
}
