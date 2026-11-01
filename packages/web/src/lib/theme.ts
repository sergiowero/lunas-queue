// Tema claro u oscuro (ADR tema-claro-oscuro). La clase `dark` de <html> es el tema efectivo: el
// script inline de index.html la pone antes de montar React y aquí solo se lee y se cambia. Fuera
// del navegador normal (localStorage bloqueado, sin matchMedia) se cae al tema claro sin fallar.
import { useSyncExternalStore } from "react";
import { flushSync } from "react-dom";

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

/** Punto de la pantalla desde el que crece el revelado circular (normalmente el botón pulsado). */
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
 * Cambia el tema con animación: un revelado circular desde `origin` donde hay View Transitions y un
 * fundido corto de colores si no. Sin cambio real o con movimiento reducido se aplica directo.
 * `flushSync` deja el DOM actualizado (icono incluido) dentro del callback de la transición.
 */
function transition(theme: Theme, origin?: RevealOrigin) {
  const root = document.documentElement;
  const update = () => flushSync(() => apply(theme));
  if (currentTheme() === theme || prefersReducedMotion()) {
    update();
    return;
  }

  if (typeof document.startViewTransition === "function") {
    // En porcentajes del viewport: Brave no respeta los px en el clip-path del pseudo-elemento y el
    // círculo salía desde arriba al centro. Un radio en % se mide sobre hypot(w, h) / √2.
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

/** La elección de la persona: se aplica (animada) y se recuerda entre recargas. */
export function setTheme(theme: Theme, origin?: RevealOrigin) {
  transition(theme, origin);
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
