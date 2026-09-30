"use client";

import { useEffect, useState } from "react";

const STORAGE_KEY = "envoy-theme";
type Theme = "light" | "dark" | null; // null = follow the OS preference

function readStored(): Theme {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "dark" || v === "light" ? v : null;
  } catch {
    return null;
  }
}

/**
 * A toggle button, not two radio options — most people just want "make it
 * dark/light right now," and this stays a one-click affordance for that.
 * The explicit choice is persisted; with none stored, layout.tsx's inline
 * script and the CSS's prefers-color-scheme block already follow the OS.
 */
export function ThemeToggle() {
  const [theme, setThemeState] = useState<Theme>(null);
  const [systemDark, setSystemDark] = useState(false);

  useEffect(() => {
    setThemeState(readStored());
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    setSystemDark(mq.matches);
    const onChange = () => setSystemDark(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  function apply(next: Theme) {
    setThemeState(next);
    try {
      if (next) {
        document.documentElement.dataset.theme = next;
        localStorage.setItem(STORAGE_KEY, next);
      } else {
        delete document.documentElement.dataset.theme;
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch {
      // Private browsing or storage disabled — the toggle still works for this page load.
      if (next) document.documentElement.dataset.theme = next;
      else delete document.documentElement.dataset.theme;
    }
  }

  const isDark = theme === "dark" || (theme === null && systemDark);

  return (
    <button
      type="button"
      className="btn theme-toggle"
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      onClick={() => apply(isDark ? "light" : "dark")}
    >
      {isDark ? "☀" : "☾"}
    </button>
  );
}
