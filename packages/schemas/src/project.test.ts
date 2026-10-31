import { describe, expect, it } from "vitest";
import {
  AgentProfiles,
  MAX_PHASE_TIMEOUT_MINUTES,
  Project,
  ProjectCreate,
  ProjectLimits,
  ProjectUpdate,
  VerifyAgentProfile,
} from "./index.ts";

const validCreate = {
  name: "lunas-queue",
  repo: "sergiowero/lunas-queue",
  baseBranch: "main",
  localPath: "/Users/sergio/workspace/lunas-queue",
};

describe("AgentProfiles", () => {
  it("acepta effort solo con los niveles de claude --effort", () => {
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
      expect(AgentProfiles.parse({ implement: { kind: "claude", effort } }).implement.effort).toBe(
        effort,
      );
    }
    expect(() => AgentProfiles.parse({ implement: { kind: "claude", effort: "turbo" } })).toThrow();
    expect(() => VerifyAgentProfile.parse({ kind: "claude", effort: "" })).toThrow();
  });

  it("rellena las fases que faltan con claude sin args", () => {
    const profiles = AgentProfiles.parse({ implement: { kind: "claude", model: "opus" } });
    expect(profiles).toEqual({
      refine: { kind: "claude", args: [] },
      implement: { kind: "claude", model: "opus", args: [] },
      verify: { kind: "claude", args: [] },
      deliver: { kind: "claude", args: [] },
    });
  });

  it("conserva modelo y args del perfil", () => {
    const profiles = AgentProfiles.parse({
      verify: { kind: "claude", model: "sonnet", args: ["--permission-mode", "auto"] },
    });
    expect(profiles.verify).toEqual({
      kind: "claude",
      model: "sonnet",
      args: ["--permission-mode", "auto"],
    });
  });

  it.each(["refine", "implement", "verify", "deliver"])(
    "rechaza un kind desconocido en %s",
    (phase) => {
      const result = AgentProfiles.safeParse({ [phase]: { kind: "codex" } });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual([phase, "kind"]);
    },
  );

  it("el perfil de verify solo acepta kind = claude", () => {
    expect(AgentProfiles.shape.verify.safeParse({ kind: "claude" }).success).toBe(true);
    expect(AgentProfiles.shape.verify.safeParse({ kind: "codex" }).success).toBe(false);
  });

  it("verify se ata al literal claude, no a AgentKind", () => {
    // Hoy AgentKind solo tiene claude; esto sigue fallando si verify pasa a aceptar AgentKind.
    expect(AgentProfiles.shape.verify.unwrap()).toBe(VerifyAgentProfile);
    expect(VerifyAgentProfile.shape.kind.def.type).toBe("literal");
    expect(VerifyAgentProfile.shape.kind.value).toBe("claude");
    expect(ProjectUpdate.shape.agentProfiles.unwrap().shape.verify.unwrap()).toBe(
      VerifyAgentProfile,
    );
  });

  it("rechaza fases desconocidas y modelo vacío", () => {
    expect(AgentProfiles.safeParse({ review: { kind: "claude" } }).success).toBe(false);
    expect(AgentProfiles.safeParse({ refine: { kind: "claude", model: "" } }).success).toBe(false);
  });
});

describe("ProjectLimits", () => {
  it("acepta límites vacíos", () => {
    expect(ProjectLimits.parse({})).toEqual({});
  });

  it("acepta concurrencia, timeout por fase y tope de iteraciones", () => {
    const limits = {
      concurrency: 2,
      phaseTimeoutMinutes: { implement: 60 },
      maxVerificationIterations: 5,
    };
    expect(ProjectLimits.parse(limits)).toEqual(limits);
  });

  it.each([
    { concurrency: 0 },
    { concurrency: 1.5 },
    { phaseTimeoutMinutes: { verify: 0 } },
    { phaseTimeoutMinutes: { review: 10 } },
    { global: 5 },
    { maxVerificationIterations: 0 },
    { maxVerificationIterations: 21 },
  ])("rechaza %j", (limits) => {
    expect(ProjectLimits.safeParse(limits).success).toBe(false);
  });
});

describe("ProjectCreate", () => {
  it("aplica defaults de perfiles y límites", () => {
    const project = ProjectCreate.parse(validCreate);
    expect(project.agentProfiles.verify).toEqual({ kind: "claude", args: [] });
    expect(project.limits).toEqual({});
    expect(project.testCommand).toBeUndefined();
  });

  it("acepta comando de tests y bootstrap", () => {
    const project = ProjectCreate.parse({
      ...validCreate,
      testCommand: "pnpm test",
      bootstrap: "pnpm install",
    });
    expect(project).toMatchObject({ testCommand: "pnpm test", bootstrap: "pnpm install" });
  });

  it.each([
    ["repo sin owner", { repo: "lunas-queue" }],
    ["repo con url", { repo: "https://github.com/sergiowero/lunas-queue" }],
    ["ruta relativa", { localPath: "workspace/lunas-queue" }],
    ["rama vacía", { baseBranch: "" }],
    ["nombre vacío", { name: " " }],
    ["comando de tests vacío", { testCommand: "" }],
    ["verify con otro kind", { agentProfiles: { verify: { kind: "codex" } } }],
  ])("rechaza %s", (_label, overrides) => {
    expect(ProjectCreate.safeParse({ ...validCreate, ...overrides }).success).toBe(false);
  });

  it("rechaza campos desconocidos", () => {
    expect(ProjectCreate.safeParse({ ...validCreate, id: "x" }).success).toBe(false);
  });
});

describe("ProjectUpdate", () => {
  it("es parcial y no aplica defaults", () => {
    expect(ProjectUpdate.parse({ baseBranch: "develop" })).toEqual({ baseBranch: "develop" });
  });

  it("permite borrar comando de tests y bootstrap con null", () => {
    expect(ProjectUpdate.parse({ testCommand: null, bootstrap: null })).toEqual({
      testCommand: null,
      bootstrap: null,
    });
  });

  it("valida el perfil de verify", () => {
    const result = ProjectUpdate.safeParse({ agentProfiles: { verify: { kind: "codex" } } });
    expect(result.success).toBe(false);
  });
});

describe("Project", () => {
  it("incluye id y tiempos", () => {
    const now = new Date();
    const project = Project.parse({
      ...ProjectCreate.parse(validCreate),
      id: crypto.randomUUID(),
      testCommand: null,
      bootstrap: null,
      createdAt: now,
      updatedAt: now,
    });
    expect(project.createdAt).toBe(now);
  });
});

describe("normalización y formato", () => {
  it.each(["/r/a/", "/r/./a", "//r//a", "/r/b/../a"])("normaliza %s a /r/a", (localPath) => {
    expect(ProjectCreate.parse({ ...validCreate, localPath }).localPath).toBe("/r/a");
  });

  it.each(["/", "/..", "/./"])("rechaza la raíz (%s)", (localPath) => {
    expect(ProjectCreate.safeParse({ ...validCreate, localPath }).success).toBe(false);
  });

  it("acepta owners con guion bajo", () => {
    expect(ProjectCreate.safeParse({ ...validCreate, repo: "user_corp/repo.js" }).success).toBe(
      true,
    );
  });

  it.each(["-x/y", "x/..", "x/.", "_x/y"])("rechaza el repo %s", (repo) => {
    expect(ProjectCreate.safeParse({ ...validCreate, repo }).success).toBe(false);
  });

  it("limita el timeout de fase a una semana", () => {
    const at = (minutes: number) =>
      ProjectLimits.safeParse({ phaseTimeoutMinutes: { implement: minutes } }).success;
    expect(at(MAX_PHASE_TIMEOUT_MINUTES)).toBe(true);
    expect(at(MAX_PHASE_TIMEOUT_MINUTES + 1)).toBe(false);
  });

  it("el PATCH de agentProfiles es parcial por fase y sin defaults", () => {
    const patch = ProjectUpdate.parse({
      agentProfiles: { verify: { kind: "claude", model: "sonnet" } },
    });
    expect(patch.agentProfiles).toEqual({ verify: { kind: "claude", model: "sonnet", args: [] } });
  });
});
