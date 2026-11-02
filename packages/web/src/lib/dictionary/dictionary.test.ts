import { describe, expect, it } from "vitest";
import { en } from "./en.ts";
import { es } from "./es.ts";

/** Dotted path of every leaf (string or function) of a dictionary. */
function leaves(node: unknown, prefix = ""): [string, unknown][] {
  if (typeof node === "string" || typeof node === "function") return [[prefix, node]];
  return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) =>
    leaves(value, prefix === "" ? key : `${prefix}.${key}`),
  );
}

describe("dictionaries", () => {
  it("English has exactly the same keys as Spanish", () => {
    expect(leaves(en).map(([path]) => path)).toEqual(leaves(es).map(([path]) => path));
  });

  it("no value is empty", () => {
    for (const dictionary of [es, en]) {
      for (const [path, value] of leaves(dictionary)) {
        if (typeof value === "string") expect(value.trim(), path).not.toBe("");
      }
    }
  });

  it("parameterized texts keep the same arity in both languages", () => {
    const english = new Map(leaves(en));
    for (const [path, value] of leaves(es)) {
      if (typeof value === "function") {
        expect((english.get(path) as (...args: unknown[]) => unknown).length, path).toBe(
          value.length,
        );
      }
    }
  });
});
