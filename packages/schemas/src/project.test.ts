import { describe, expect, it } from "vitest";
import { AgentProfiles, Project, ProjectCreate, ProjectLimits, ProjectUpdate } from "./index.ts";

const validCreate = {
  name: "lunas-queue",
  repo: "sergiowero/lunas-queue",
  baseBranch: "main",
  localPath: "/Users/sergio/workspace/lunas-queue",
};

describe("AgentProfiles", () => {
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

  it("rechaza fases desconocidas y modelo vacío", () => {
    expect(AgentProfiles.safeParse({ review: { kind: "claude" } }).success).toBe(false);
    expect(AgentProfiles.safeParse({ refine: { kind: "claude", model: "" } }).success).toBe(false);
  });
});

describe("ProjectLimits", () => {
  it("acepta límites vacíos", () => {
    expect(ProjectLimits.parse({})).toEqual({});
  });

  it("acepta concurrencia y timeout por fase", () => {
    const limits = { concurrency: 2, phaseTimeoutMinutes: { implement: 60 } };
    expect(ProjectLimits.parse(limits)).toEqual(limits);
  });

  it.each([
    { concurrency: 0 },
    { concurrency: 1.5 },
    { phaseTimeoutMinutes: { verify: 0 } },
    { phaseTimeoutMinutes: { review: 10 } },
    { global: 5 },
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
