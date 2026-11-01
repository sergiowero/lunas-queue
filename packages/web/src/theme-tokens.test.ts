// El tema oscuro redefine cada token de color del claro (AC-8): un token sin su par oscuro
// dejaría ese color fijo del tema claro en pantalla.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { badgeVariants } from "./components/ui/badge.tsx";
import { buttonVariants } from "./components/ui/button.tsx";

const css = readFileSync(join(import.meta.dirname, "index.css"), "utf8");

// MoonlightQ usa el mismo valor en ambos temas para estos tokens (texto blanco sobre el relleno
// sólido, el rojo de peligro): lo que importa es que el oscuro los declare.
const SAME_IN_BOTH_THEMES = new Set([
  "--color-primary-fg",
  "--color-danger",
  "--color-danger-fg",
  "--color-info-fg",
  "--color-accent-fg",
]);

function tokens(block: string): Map<string, string> {
  return new Map(
    [...block.matchAll(/(--color-[\w-]+):\s*([^;]+);/g)].map((m) => [m[1] ?? "", m[2] ?? ""]),
  );
}

function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `falta el bloque ${selector}`).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start));
}

describe("tokens del tema oscuro", () => {
  it("el tema oscuro redefine cada token de color del tema claro con otro valor", () => {
    const light = tokens(block("@theme"));
    const dark = tokens(block(".dark"));
    expect(light.size).toBeGreaterThan(0);
    for (const [name, value] of light) {
      expect(dark.has(name), `${name} sin valor oscuro`).toBe(true);
      if (SAME_IN_BOTH_THEMES.has(name)) continue;
      expect(dark.get(name), `${name} igual en ambos temas`).not.toBe(value);
    }
  });

  it("la variante dark de Tailwind depende de la clase dark de <html>", () => {
    expect(css).toMatch(/@custom-variant dark \(&:where\(\.dark, \.dark \*\)\);/);
  });
});

// Luminancia relativa (WCAG) de un `#rrggbb` o un `oklch(L C h)` opaco, vía OKLab → sRGB lineal.
function luminance(color: string): number {
  const hex = color.match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i);
  if (hex) {
    const [r, g, bl] = [1, 2, 3].map((i) => {
      const v = Number.parseInt(hex[i] ?? "0", 16) / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (bl ?? 0);
  }
  const m = color.match(/^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/);
  expect(m, `color no soportado: ${color}`).not.toBeNull();
  const [l, c, h] = [Number(m?.[1]), Number(m?.[2]), (Number(m?.[3]) * Math.PI) / 180];
  const [a, b] = [c * Math.cos(h), c * Math.sin(h)];
  const l3 = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m3 = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s3 = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const r = clamp(4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3);
  const g = clamp(-1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3);
  const bl = clamp(-0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3);
  return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
}

function contrast(fg: string, bg: string): number {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

describe("contraste de las variantes destructivas", () => {
  it.each([
    ["claro", "@theme"],
    ["oscuro", ".dark"],
  ])("en tema %s, el texto sobre el fondo destructivo cumple el 4.5:1 de AA", (_, selector) => {
    const t = tokens(block(selector));
    const fg = t.get("--color-danger-fg");
    const bg = t.get("--color-danger");
    expect(fg, "falta --color-danger-fg").toBeDefined();
    expect(contrast(fg ?? "", bg ?? "")).toBeGreaterThanOrEqual(4.5);
  });

  it("el badge y el botón destructivos usan el texto del token, no un blanco fijo", () => {
    for (const classes of [
      badgeVariants({ variant: "destructive" }),
      buttonVariants({ variant: "destructive" }),
    ]) {
      expect(classes).toContain("text-danger");
      expect(classes).not.toContain("text-white");
    }
  });
});
