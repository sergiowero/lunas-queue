// The inline script of index.html sets the theme and the language before React mounts, so a reload
// in the dark theme does not flash light (AC-9) and one in English does not pass through Spanish.
// It must resolve the same as lib/theme.ts and lib/i18n.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LANGUAGE_KEY } from "../src/lib/i18n.ts";
import { THEME_KEY } from "../src/lib/theme.ts";
import { stubColorScheme } from "./render.tsx";

const page = readFileSync(join(import.meta.dirname, "..", "index.html"), "utf8");
const doc = new DOMParser().parseFromString(page, "text/html");
const inline = [...doc.querySelectorAll("script")].find((s) => !s.src && !s.type);
const html = document.documentElement;

function runInline() {
  new Function(inline?.textContent ?? "")();
}

describe("theme before mounting React", () => {
  it("the inline script goes in <head>, before the app module", () => {
    expect(inline?.parentElement?.tagName).toBe("HEAD");
    const scripts = [...doc.querySelectorAll("script")];
    const app = scripts.find((s) => s.getAttribute("src") === "/src/main.tsx");
    expect(scripts.indexOf(inline as HTMLScriptElement)).toBeLessThan(
      scripts.indexOf(app as HTMLScriptElement),
    );
  });

  it("with «dark» saved it applies the dark class to <html> even if the system is light", () => {
    stubColorScheme("light");
    localStorage.setItem(THEME_KEY, "dark");
    runInline();
    expect(html.classList.contains("dark")).toBe(true);
  });

  it("without a saved preference it follows the system dark", () => {
    stubColorScheme("dark");
    runInline();
    expect(html.classList.contains("dark")).toBe(true);
  });

  it("with «light» saved or an invalid value it does not apply the dark class", () => {
    stubColorScheme("light");
    localStorage.setItem(THEME_KEY, "sepia");
    runInline();
    expect(html.classList.contains("dark")).toBe(false);
    stubColorScheme("dark");
    localStorage.setItem(THEME_KEY, "light");
    runInline();
    expect(html.classList.contains("dark")).toBe(false);
  });

  it("does not fail with a localStorage that throws or without matchMedia", () => {
    vi.stubGlobal("matchMedia", undefined);
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("SecurityError");
      },
      clear: () => {},
    });
    expect(runInline).not.toThrow();
    expect(html.classList.contains("dark")).toBe(false);
  });
});

describe("language before mounting React", () => {
  it("without a stored preference sets lang to es", () => {
    runInline();
    expect(html.lang).toBe("es");
  });

  it("with «en» stored sets lang to en", () => {
    localStorage.setItem(LANGUAGE_KEY, "en");
    runInline();
    expect(html.lang).toBe("en");
  });

  it("with an invalid value keeps es", () => {
    localStorage.setItem(LANGUAGE_KEY, "fr");
    runInline();
    expect(html.lang).toBe("es");
  });

  it("does not fail with a localStorage that throws and falls back to es", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("SecurityError");
      },
      clear: () => {},
    });
    expect(runInline).not.toThrow();
    expect(html.lang).toBe("es");
  });
});
