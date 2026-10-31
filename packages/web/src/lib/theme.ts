// Tema claro u oscuro (ADR tema-claro-oscuro). La clase `dark` de <html> es el tema efectivo: el
// script inline de index.html la pone antes de montar React y aquí solo se lee y se cambia. Fuera
// del navegador normal (localStorage bloqueado, sin matchMedia) se cae al tema claro sin fallar.
import { useSyncExternalStore } from "react";

export type Theme = "light" | "dark";

/** La misma clave usa el script inline de index.html. */
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

/** La preferencia guardada si es válida; si no, la del sistema; si no, claro. */
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

/** Al cargar: aplica el tema resuelto sin guardarlo, así seguir al sistema no queda fijado. */
export function initTheme() {
  apply(resolveTheme());
}

/** La elección de la persona: se aplica y se recuerda entre recargas. */
export function setTheme(theme: Theme) {
  apply(theme);
  try {
    globalThis.localStorage?.setItem(THEME_KEY, theme);
  } catch {
    // Sin almacenamiento el tema vale para esta sesión.
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, currentTheme);
}
