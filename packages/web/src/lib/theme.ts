// Light or dark theme (ADR tema-claro-oscuro). The `dark` class on <html> is the effective theme: the
// inline script in index.html sets it before mounting React and here it is only read and changed. Outside
// a normal browser (blocked localStorage, no matchMedia) it falls back to the light theme without failing.
import { useSyncExternalStore } from "react";
import { flushSync } from "react-dom";

export type Theme = "light" | "dark";

/** The same key is used by index.html's inline script. */
export const THEME_KEY = "lunasq:theme";

const listeners = new Set<() => void>();

function storedTheme(): Theme | null {
  try {
    const value = globalThis.localStorage?.getItem(THEME_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

function systemTheme(): Theme | null {
  try {
    if (typeof globalThis.matchMedia !== "function") return null;
    return globalThis.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : null;
  } catch {
    return null;
  }
}

/** The saved preference if valid; otherwise the system's; otherwise light. */
export function resolveTheme(): Theme {
  return storedTheme() ?? systemTheme() ?? "light";
}

export function currentTheme(): Theme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function apply(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  for (const listener of listeners) listener();
}

/** On load: applies the resolved theme without saving it, so following the system does not get pinned. */
export function initTheme() {
  apply(resolveTheme());
}

/** Point on the screen from which the circular reveal grows (normally the clicked button). */
export interface RevealOrigin {
  x: number;
  y: number;
}

function prefersReducedMotion() {
  try {
    return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  } catch {
    return false;
  }
}

/**
 * Switches the theme with animation: a circular reveal from `origin` where View Transitions exist and a
 * short color fade if not. Without a real change or with reduced motion it is applied directly.
 * `flushSync` leaves the DOM updated (icon included) inside the transition callback.
 */
function transition(theme: Theme, origin?: RevealOrigin) {
  const root = document.documentElement;
  const update = () => flushSync(() => apply(theme));
  if (currentTheme() === theme || prefersReducedMotion()) {
    update();
    return;
  }

  if (typeof document.startViewTransition === "function") {
    // In viewport percentages: Brave does not honor px in the pseudo-element's clip-path and the
    // circle came out from the top to the center. A radius in % is measured over hypot(w, h) / √2.
    const width = root.clientWidth || window.innerWidth;
    const height = root.clientHeight || window.innerHeight;
    const x = origin?.x ?? width / 2;
    const y = origin?.y ?? height / 2;
    const at = `at ${(x / width) * 100}% ${(y / height) * 100}%`;
    const radius =
      (Math.hypot(Math.max(x, width - x), Math.max(y, height - y)) /
        (Math.hypot(width, height) / Math.SQRT2)) *
      100;
    document
      .startViewTransition(update)
      .ready.then(() => {
        root.animate(
          { clipPath: [`circle(0% ${at})`, `circle(${radius}% ${at})`] },
          {
            duration: 480,
            easing: "cubic-bezier(0.65, 0, 0.35, 1)",
            pseudoElement: "::view-transition-new(root)",
          },
        );
      })
      .catch(() => {});
    return;
  }

  root.classList.add("theme-transition");
  update();
  window.setTimeout(() => root.classList.remove("theme-transition"), 320);
}

/** The person's choice: it is applied (animated) and remembered across reloads. */
export function setTheme(theme: Theme, origin?: RevealOrigin) {
  transition(theme, origin);
  try {
    globalThis.localStorage?.setItem(THEME_KEY, theme);
  } catch {
    // Without storage the theme holds for this session.
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, currentTheme);
}
