import { describe, expect, it } from "vitest";
import {
  DEFAULT_HOOK_POLICY,
  DEFAULT_HOOK_TIMEOUT_SECONDS,
  hookPointEscalates,
  hookPointOutcome,
  hookPointPhase,
  hookPointRunsInWorktree,
  parseHooksConfig,
  planHooks,
} from "./hooks.ts";

describe("parseHooksConfig", () => {
  it("sin archivo no hay ajustes", () => {
    expect(parseHooksConfig(undefined)).toEqual({ ok: true, config: {} });
  });

  it("lee el JSON validado", () => {
    const text = JSON.stringify({ after_merge: { "10-deploy": { policy: "warn" } } });
    expect(parseHooksConfig(text)).toEqual({
      ok: true,
      config: { after_merge: { "10-deploy": { policy: "warn" } } },
    });
  });

  it("un JSON roto o fuera de esquema es un error con mensaje", () => {
    const broken = parseHooksConfig("{ after_merge: ");
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.message).toMatch(/JSON/);

    const invalid = parseHooksConfig(JSON.stringify({ after_merge: { a: { policy: "x" } } }));
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.message).toMatch(/after_merge/);
  });
});

describe("planHooks", () => {
  it("ordena alfabéticamente por nombre de archivo", () => {
    const plan = planHooks("before_delivery", ["20-changelog", "10-bump", "05-a", "B", "a"], {});
    expect(plan.map((h) => h.script)).toEqual(["05-a", "10-bump", "20-changelog", "B", "a"]);
  });

  it("sin ajustes usa política block y el timeout por defecto", () => {
    expect(DEFAULT_HOOK_POLICY).toBe("block");
    expect(planHooks("after_merge", ["deploy"], {})).toEqual([
      { script: "deploy", policy: "block", timeoutSeconds: DEFAULT_HOOK_TIMEOUT_SECONDS },
    ]);
  });

  it("aplica los ajustes del punto y del script, e ignora los de scripts que no existen", () => {
    const plan = planHooks("before_delivery", ["10-bump", "20-changelog"], {
      before_delivery: {
        "10-bump": { timeoutSeconds: 30 },
        "20-changelog": { policy: "warn" },
        "99-missing": { policy: "warn" },
      },
      after_delivery: { "10-bump": { policy: "warn" } },
    });
    expect(plan).toEqual([
      { script: "10-bump", policy: "block", timeoutSeconds: 30 },
      { script: "20-changelog", policy: "warn", timeoutSeconds: DEFAULT_HOOK_TIMEOUT_SECONDS },
    ]);
  });
});

describe("hookPointOutcome", () => {
  it("todo en verde pasa; un warn fallido avisa; un block fallido bloquea", () => {
    expect(hookPointOutcome([])).toBe("passed");
    expect(hookPointOutcome([{ policy: "block", passed: true }])).toBe("passed");
    expect(
      hookPointOutcome([
        { policy: "warn", passed: false },
        { policy: "block", passed: true },
      ]),
    ).toBe("warned");
    expect(
      hookPointOutcome([
        { policy: "warn", passed: false },
        { policy: "block", passed: false },
      ]),
    ).toBe("blocked");
  });
});

describe("puntos de enganche", () => {
  it("cada punto de fase sabe su fase", () => {
    expect(hookPointPhase("before_refinement")).toBe("refine");
    expect(hookPointPhase("after_implementation")).toBe("implement");
    expect(hookPointPhase("before_verification")).toBe("verify");
    expect(hookPointPhase("after_delivery")).toBe("deliver");
    expect(hookPointPhase("after_merge")).toBeNull();
    expect(hookPointPhase("on_failure")).toBeNull();
  });

  it("after_merge corre en el checkout de la rama base; el resto en el worktree", () => {
    expect(hookPointRunsInWorktree("after_merge")).toBe(false);
    expect(hookPointRunsInWorktree("before_delivery")).toBe(true);
    expect(hookPointRunsInWorktree("on_failure")).toBe(true);
  });

  it("solo los puntos de fase escalan: after_merge llega con la tarea terminada y on_failure tras un Run fallido", () => {
    expect(hookPointEscalates("before_delivery")).toBe(true);
    expect(hookPointEscalates("after_refinement")).toBe(true);
    expect(hookPointEscalates("after_merge")).toBe(false);
    expect(hookPointEscalates("on_failure")).toBe(false);
  });
});
