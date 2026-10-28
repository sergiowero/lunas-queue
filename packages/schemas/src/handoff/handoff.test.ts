import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CURRENT_HANDOFF_VERSION,
  HANDOFF_MAX_BYTES,
  type HandoffError,
  parseHandoff,
  REVIEWER_NAMES,
} from "./index.ts";

const examplesDir = join(import.meta.dirname, "../../examples/handoff/v1");

interface InvalidExample {
  description: string;
  expectedErrors: { path: string; message?: string }[];
  handoff: unknown;
}

function readExamples<T>(kind: "valid" | "invalid"): [string, T][] {
  const dir = join(examplesDir, kind);
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => [file, JSON.parse(readFileSync(join(dir, file), "utf8")) as T]);
}

function expectErrors(input: unknown): HandoffError[] {
  const result = parseHandoff(input);
  if (result.success) throw new Error("se esperaba un handoff inválido");
  return result.errors;
}

function validExample(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(examplesDir, "valid", `${name}.json`), "utf8"));
}

describe("handoff v1: ejemplos válidos", () => {
  const examples = readExamples<unknown>("valid");

  it("hay al menos un ejemplo por fase", () => {
    const phases = new Set(examples.map(([, h]) => (h as { phase: string }).phase));
    expect([...phases].sort()).toEqual(["implementation", "refinement", "verification"]);
  });

  it.each(examples)("acepta %s", (_file, handoff) => {
    const result = parseHandoff(handoff);
    expect(result.success ? [] : result.errors).toEqual([]);
    expect(result.success && result.data).toEqual(handoff);
  });
});

describe("handoff v1: ejemplos inválidos", () => {
  it.each(readExamples<InvalidExample>("invalid"))("rechaza %s", (_file, example) => {
    const errors = expectErrors(example.handoff);
    // Cada ejemplo falla solo por la razón que declara.
    expect(errors.map((e) => e.path).sort(), example.description).toEqual(
      example.expectedErrors.map((e) => e.path).sort(),
    );
    for (const expected of example.expectedErrors) {
      const match = errors.find(
        (error) =>
          error.path === expected.path &&
          (expected.message === undefined ||
            error.message.toLowerCase().includes(expected.message.toLowerCase())),
      );
      expect(match, `${example.description}: ${JSON.stringify(errors)}`).toBeDefined();
    }
  });
});

describe("handoff: errores claros", () => {
  it("cada error trae ruta legible y mensaje en español", () => {
    const handoff = validExample("refinement");
    (handoff.body as { criteria: { id: string }[] }).criteria[0] = { id: "x" } as never;
    const errors = expectErrors(handoff);
    expect(errors).toContainEqual({
      path: "body.criteria[0].id",
      message: expect.stringContaining("AC-"),
    });
    expect(errors).toContainEqual({
      path: "body.criteria[0].given",
      message: expect.stringMatching(/se esperaba texto/i),
    });
  });

  it("rechaza entradas que no son objeto", () => {
    expect(expectErrors("hola")).toEqual([
      { path: "(raíz)", message: expect.stringContaining("objeto") },
    ]);
  });

  it("explica qué estados admite un revisor", () => {
    const handoff = validExample("verification-pass");
    (handoff.body as { reviewers: Record<string, unknown> }).reviewers["lunasq-ui-reviewer"] = {
      status: "bogus",
    };
    expect(expectErrors(handoff)).toEqual([
      {
        path: "body.reviewers.lunasq-ui-reviewer.status",
        message: expect.stringContaining("ran o skipped"),
      },
    ]);
  });

  it("distingue una versión escrita como texto", () => {
    const handoff = { ...validExample("implementation"), schemaVersion: "1" };
    expect(expectErrors(handoff)).toEqual([
      { path: "schemaVersion", message: expect.stringContaining('"1"') },
    ]);
  });

  it("devuelve errores en vez de lanzar con entradas no serializables", () => {
    const handoff: Record<string, unknown> = validExample("implementation");
    handoff.self = handoff;
    expect(expectErrors(handoff)).toEqual([
      { path: "(raíz)", message: expect.stringContaining("serializable") },
    ]);
  });

  it("rechaza un handoff sin versión de esquema", () => {
    const { schemaVersion: _, ...rest } = validExample("implementation");
    expect(expectErrors(rest)).toEqual([
      { path: "schemaVersion", message: expect.stringContaining("soportadas: 1") },
    ]);
  });
});

describe("handoff: tamaño acotado", () => {
  it(`mide en bytes UTF-8 y rechaza un handoff de más de ${HANDOFF_MAX_BYTES} bytes`, () => {
    const handoff = validExample("implementation");
    handoff.knownRisks = Array.from({ length: 20 }, () => "ñ".repeat(1000));
    expect(JSON.stringify(handoff).length).toBeLessThan(HANDOFF_MAX_BYTES);
    expect(expectErrors(handoff)).toEqual([
      { path: "(raíz)", message: expect.stringContaining(`${HANDOFF_MAX_BYTES} bytes`) },
    ]);
  });
});

describe("handoff: versiones", () => {
  it("la versión vigente es 1", () => {
    expect(CURRENT_HANDOFF_VERSION).toBe(1);
  });

  it("el veredicto exige exactamente los 4 revisores", () => {
    expect(REVIEWER_NAMES).toEqual([
      "lunasq-security-reviewer",
      "lunasq-ux-reviewer",
      "lunasq-ui-reviewer",
      "lunasq-code-reviewer",
    ]);
    const handoff = validExample("verification-pass");
    (handoff.body as { reviewers: Record<string, unknown> }).reviewers["lunasq-extra-reviewer"] = {
      status: "ran",
      findings: [],
    };
    expect(expectErrors(handoff)).toContainEqual({
      path: "body.reviewers",
      message: expect.stringContaining("lunasq-extra-reviewer"),
    });
  });
});
