// El script inline de index.html pone el tema antes de que React monte, para que una recarga en
// tema oscuro no destelle en claro (AC-9). Debe resolver igual que lib/theme.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { THEME_KEY } from "../src/lib/theme.ts";
import { stubColorScheme } from "./render.tsx";

const page = readFileSync(join(import.meta.dirname, "..", "index.html"), "utf8");
const doc = new DOMParser().parseFromString(page, "text/html");
const inline = [...doc.querySelectorAll("script")].find((s) => !s.src && !s.type);
const html = document.documentElement;

function runInline() {
  new Function(inline?.textContent ?? "")();
}

describe("tema antes de montar React", () => {
  it("el script inline va en <head>, antes del módulo de la app", () => {
    expect(inline?.parentElement?.tagName).toBe("HEAD");
    const scripts = [...doc.querySelectorAll("script")];
    const app = scripts.find((s) => s.getAttribute("src") === "/src/main.tsx");
    expect(scripts.indexOf(inline as HTMLScriptElement)).toBeLessThan(
      scripts.indexOf(app as HTMLScriptElement),
    );
  });

  it("con «dark» guardado aplica la clase dark a <html> aunque el sistema esté en claro", () => {
    stubColorScheme("light");
    localStorage.setItem(THEME_KEY, "dark");
    runInline();
    expect(html.classList.contains("dark")).toBe(true);
  });

  it("sin preferencia guardada sigue al sistema en oscuro", () => {
    stubColorScheme("dark");
    runInline();
    expect(html.classList.contains("dark")).toBe(true);
  });

  it("con «light» guardado o un valor inválido no aplica la clase dark", () => {
    stubColorScheme("light");
    localStorage.setItem(THEME_KEY, "sepia");
    runInline();
    expect(html.classList.contains("dark")).toBe(false);
    stubColorScheme("dark");
    localStorage.setItem(THEME_KEY, "light");
    runInline();
    expect(html.classList.contains("dark")).toBe(false);
  });

  it("no falla con un localStorage que lanza error ni sin matchMedia", () => {
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
