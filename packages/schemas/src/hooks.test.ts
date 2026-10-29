import { describe, expect, it } from "vitest";
import {
  HOOK_OUTPUT_LIMIT,
  HookExecutedPayload,
  HookPoint,
  HookPointCompletedPayload,
  HooksConfig,
} from "./hooks.ts";

const sha = "a".repeat(40);

describe("puntos de enganche", () => {
  it("before y after de cada fase, after_merge y on_failure", () => {
    expect(HookPoint.options).toEqual([
      "before_refinement",
      "after_refinement",
      "before_implementation",
      "after_implementation",
      "before_verification",
      "after_verification",
      "before_delivery",
      "after_delivery",
      "after_merge",
      "on_failure",
    ]);
  });
});

describe("lunasq/hooks/config", () => {
  it("timeout y política por script, agrupados por punto", () => {
    const config = {
      before_delivery: { "10-bump-version": { timeoutSeconds: 300, policy: "warn" } },
      after_merge: { "10-deploy": { policy: "block" } },
    };
    expect(HooksConfig.parse(config)).toEqual(config);
    expect(HooksConfig.parse({})).toEqual({});
  });

  it("rechaza puntos desconocidos, campos extra y nombres que no son un archivo", () => {
    expect(() => HooksConfig.parse({ before_lunch: {} })).toThrow();
    expect(() => HooksConfig.parse({ after_merge: { a: { retries: 2 } } })).toThrow();
    expect(() => HooksConfig.parse({ after_merge: { "../a": {} } })).toThrow();
    expect(() => HooksConfig.parse({ after_merge: { "a/b": {} } })).toThrow();
  });

  it("rechaza políticas desconocidas y timeouts no positivos o enormes", () => {
    expect(() => HooksConfig.parse({ after_merge: { a: { policy: "ignore" } } })).toThrow();
    expect(() => HooksConfig.parse({ after_merge: { a: { timeoutSeconds: 0 } } })).toThrow();
    expect(() => HooksConfig.parse({ after_merge: { a: { timeoutSeconds: 1.5 } } })).toThrow();
    expect(() =>
      HooksConfig.parse({ after_merge: { a: { timeoutSeconds: 8 * 24 * 3600 } } }),
    ).toThrow();
  });
});

describe("eventos de hooks", () => {
  const executed = {
    point: "before_delivery",
    script: "10-bump-version",
    baseRef: sha,
    runId: null,
    policy: "block",
    timeoutSeconds: 600,
    exitCode: 0,
    timedOut: false,
    durationMs: 12,
    passed: true,
    output: "ok\n",
  };

  it("hook.executed guarda resultado, duración y salida", () => {
    expect(HookExecutedPayload.parse(executed)).toEqual(executed);
    expect(() => HookExecutedPayload.parse({ ...executed, baseRef: "main" })).toThrow();
    expect(() =>
      HookExecutedPayload.parse({ ...executed, output: "x".repeat(HOOK_OUTPUT_LIMIT + 1) }),
    ).toThrow();
  });

  it("hook.point_completed resume el punto", () => {
    const completed = {
      point: "before_delivery",
      baseRef: sha,
      runId: "run-1",
      outcome: "blocked",
      failedScript: "10-bump-version",
      error: null,
      commit: null,
      commitSkipped: false,
    };
    expect(HookPointCompletedPayload.parse(completed)).toEqual(completed);
    // Sin base legible (fetch o config inválida) no hay ref.
    expect(
      HookPointCompletedPayload.parse({ ...completed, baseRef: null, error: "config inválida" })
        .baseRef,
    ).toBeNull();
    expect(() => HookPointCompletedPayload.parse({ ...completed, outcome: "ok" })).toThrow();
  });
});
