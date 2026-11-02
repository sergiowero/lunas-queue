import { describe, expect, it } from "vitest";
import { parseResultHandoff, RESULT_MAX_CHARS, ResultHandoff } from "./result.ts";

const valid = {
  schemaVersion: 1,
  taskId: "0b6f4c1e-5d1a-4f7e-9c3a-2e8d7f6a5b4c",
  runId: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
  phase: "refinement",
  summary: "La investigación concluye que conviene SQLite.",
  title: "Elegir la base de datos",
  resultKind: "research",
  result: "# Hallazgos\n\nSQLite basta para un solo proceso.",
};

const paths = (input: unknown) => {
  const parsed = parseResultHandoff(input);
  return parsed.success ? [] : parsed.errors.map((e) => e.path);
};

describe("handoff de submit_result", () => {
  it("acepta el handoff de refinamiento y el de implementación", () => {
    expect(parseResultHandoff(valid)).toEqual({ success: true, data: valid });
    const implementation = { ...valid, phase: "implementation", resultKind: "already_implemented" };
    expect(parseResultHandoff(implementation)).toEqual({ success: true, data: implementation });
  });

  it.each(["research", "already_implemented", "not_resolvable"])("acepta el tipo %s", (kind) => {
    expect(ResultHandoff.safeParse({ ...valid, resultKind: kind }).success).toBe(true);
  });

  it("rechaza un tipo de resultado fuera de los tres con la ruta resultKind", () => {
    expect(paths({ ...valid, resultKind: "bug" })).toEqual(["resultKind"]);
  });

  it("rechaza un texto vacío o solo espacios con la ruta result", () => {
    expect(paths({ ...valid, result: "" })).toEqual(["result"]);
    expect(paths({ ...valid, result: "   " })).toEqual(["result"]);
  });

  it("acepta un texto de 20 000 caracteres y rechaza uno de 20 001", () => {
    expect(RESULT_MAX_CHARS).toBe(20_000);
    expect(parseResultHandoff({ ...valid, result: "x".repeat(20_000) }).success).toBe(true);
    expect(paths({ ...valid, result: "x".repeat(20_001) })).toEqual(["result"]);
  });

  it("rechaza un título vacío o de más de 72 caracteres", () => {
    expect(paths({ ...valid, title: "" })).toEqual(["title"]);
    expect(paths({ ...valid, title: "t".repeat(73) })).toEqual(["title"]);
  });

  it("rechaza una fase que no es refinement ni implementation", () => {
    expect(paths({ ...valid, phase: "verification" })).toEqual(["phase"]);
  });

  it("rechaza campos desconocidos y una versión de esquema no soportada", () => {
    expect(paths({ ...valid, body: {} })).toEqual(["(raíz)"]);
    expect(paths({ ...valid, schemaVersion: 2 })).toEqual(["schemaVersion"]);
  });

  it("rechaza lo que no es un objeto", () => {
    expect(paths("texto")).toEqual(["(raíz)"]);
    expect(paths([valid])).toEqual(["(raíz)"]);
  });
});
