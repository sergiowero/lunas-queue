// UI language (ADR i18n-es-en). The `lang` attribute of <html> is the effective language: the
// inline script in index.html sets it before React mounts and here it is only read and changed.
// Without a valid stored preference the language is Spanish; a blocked localStorage only means the
// choice is valid for the current session.
import { useSyncExternalStore } from "react";
import { type Dictionary, dictionaries } from "./dictionary/index.ts";

export type Language = "es" | "en";

export const LANGUAGES: readonly Language[] = ["es", "en"];

/** The inline script in index.html uses the same key. */
export const LANGUAGE_KEY = "lunasq:lang";

export const DEFAULT_LANGUAGE: Language = "es";

const listeners = new Set<() => void>();

function isLanguage(value: unknown): value is Language {
  return value === "es" || value === "en";
}

function storedLanguage(): Language | null {
  try {
    const value = globalThis.localStorage?.getItem(LANGUAGE_KEY);
    return isLanguage(value) ? value : null;
  } catch {
    return null;
  }
}

/** The stored preference if valid; otherwise Spanish. */
export function resolveLanguage(): Language {
  return storedLanguage() ?? DEFAULT_LANGUAGE;
}

/** The effective language: `lang` of <html> when it is valid, else the resolved preference. */
export function currentLanguage(): Language {
  const lang = document.documentElement.getAttribute("lang");
  return isLanguage(lang) ? lang : resolveLanguage();
}

function apply(language: Language) {
  document.documentElement.setAttribute("lang", language);
  for (const listener of listeners) listener();
}

/** On load: applies the resolved language without saving it. */
export function initLanguage() {
  apply(resolveLanguage());
}

/** The person's choice: it is applied and remembered across reloads. */
export function setLanguage(language: Language) {
  apply(language);
  try {
    globalThis.localStorage?.setItem(LANGUAGE_KEY, language);
  } catch {
    // Without storage the language is valid for this session only.
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLanguage(): Language {
  return useSyncExternalStore(subscribe, currentLanguage);
}

/** The dictionary of the effective language. */
export function useT(): Dictionary {
  return dictionaries[useLanguage()];
}

/** Regional locale used to format dates and numbers. */
export const LOCALE: Record<Language, string> = { es: "es", en: "en" };

export function useLocale(): string {
  return LOCALE[useLanguage()];
}
