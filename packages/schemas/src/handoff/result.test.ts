import { describe, expect, it } from "vitest";
import { parseResultHandoff, RESULT_MAX_CHARS, ResultHandoff } from "./result.ts";

const valid = {
  schemaVersion: 1,
  taskId: "0b6f4c1e-5d1a-4f7e-9c3a-2e8d7f6a5b4c",
  runId: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
  phase: "refinement",
  summary: "The research concludes that SQLite is the better choice.",
  title: "Choose the database",
  resultKind: "research",
  result: "# Findings\n\nSQLite is enough for a single process.",
};

const paths = (input: unknown) => {
  const parsed = parseResultHandoff(input);
  return parsed.success ? [] : parsed.errors.map((e) => e.path);
};

describe("submit_result handoff", () => {
  it("accepts the refinement and implementation handoff", () => {
    expect(parseResultHandoff(valid)).toEqual({ success: true, data: valid });
    const implementation = { ...valid, phase: "implementation", resultKind: "already_implemented" };
    expect(parseResultHandoff(implementation)).toEqual({ success: true, data: implementation });
  });

  it.each(["research", "already_implemented", "not_resolvable"])("accepts the type %s", (kind) => {
    expect(ResultHandoff.safeParse({ ...valid, resultKind: kind }).success).toBe(true);
  });

  it("rejects a result type outside the three with the path resultKind", () => {
    expect(paths({ ...valid, resultKind: "bug" })).toEqual(["resultKind"]);
  });

  it("rejects an empty or whitespace-only text with the path result", () => {
    expect(paths({ ...valid, result: "" })).toEqual(["result"]);
    expect(paths({ ...valid, result: "   " })).toEqual(["result"]);
  });

  it("accepts a text of 20,000 characters and rejects one of 20,001", () => {
    expect(RESULT_MAX_CHARS).toBe(20_000);
    expect(parseResultHandoff({ ...valid, result: "x".repeat(20_000) }).success).toBe(true);
    expect(paths({ ...valid, result: "x".repeat(20_001) })).toEqual(["result"]);
  });

  it("rejects an empty title or one longer than 72 characters", () => {
    expect(paths({ ...valid, title: "" })).toEqual(["title"]);
    expect(paths({ ...valid, title: "t".repeat(73) })).toEqual(["title"]);
  });

  it("rejects a phase that is neither refinement nor implementation", () => {
    expect(paths({ ...valid, phase: "verification" })).toEqual(["phase"]);
  });

  it("rejects unknown fields and an unsupported schema version", () => {
    expect(paths({ ...valid, body: {} })).toEqual(["(root)"]);
    expect(paths({ ...valid, schemaVersion: 2 })).toEqual(["schemaVersion"]);
  });

  it("rejects what is not an object", () => {
    expect(paths("texto")).toEqual(["(root)"]);
    expect(paths([valid])).toEqual(["(root)"]);
  });
});
