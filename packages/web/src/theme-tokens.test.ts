// El tema oscuro redefine cada token de color del claro (AC-8): un token sin su par oscuro
// dejaría ese color fijo del tema claro en pantalla.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(import.meta.dirname, "index.css"), "utf8");

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
      expect(dark.get(name), `${name} igual en ambos temas`).not.toBe(value);
    }
  });

  it("la variante dark de Tailwind depende de la clase dark de <html>", () => {
    expect(css).toMatch(/@custom-variant dark \(&:where\(\.dark, \.dark \*\)\);/);
  });
});
