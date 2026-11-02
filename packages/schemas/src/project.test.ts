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
  it("accepts effort only with the levels of claude --effort", () => {
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
      expect(AgentProfiles.parse({ implement: { kind: "claude", effort } }).implement.effort).toBe(
        effort,
      );
    }
    expect(() => AgentProfiles.parse({ implement: { kind: "claude", effort: "turbo" } })).toThrow();
    expect(() => VerifyAgentProfile.parse({ kind: "claude", effort: "" })).toThrow();
  });

  it("fills in the missing phases with claude without args", () => {
    const profiles = AgentProfiles.parse({ implement: { kind: "claude", model: "opus" } });
    expect(profiles).toEqual({
      refine: { kind: "claude", args: [] },
      implement: { kind: "claude", model: "opus", args: [] },
      verify: { kind: "claude", args: [] },
      deliver: { kind: "claude", args: [] },
    });
  });

  it("keeps the model and args of the profile", () => {
    const profiles = AgentProfiles.parse({
      verify: { kind: "claude", model: "sonnet", args: ["--permission-mode", "auto"] },
    });
    expect(profiles.verify).toEqual({
      kind: "claude",
      model: "sonnet",
      args: ["--permission-mode", "auto"],
    });
  });

  it("accepts Copilot CLI as a provider in any phase", () => {
    const profiles = AgentProfiles.parse({
      refine: { kind: "copilot", effort: "medium" },
      implement: { kind: "copilot", model: "gpt-5" },
      verify: { kind: "copilot" },
      deliver: { kind: "copilot" },
    });
    expect(Object.values(profiles).map((profile) => profile.kind)).toEqual([
      "copilot",
      "copilot",
      "copilot",
      "copilot",
    ]);
  });

  it.each(["refine", "implement", "verify", "deliver"])(
    "rejects an unknown kind in %s",
    (phase) => {
      const result = AgentProfiles.safeParse({ [phase]: { kind: "codex" } });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual([phase, "kind"]);
    },
  );

  it("verify uses the same per-provider profile schema as the other phases", () => {
    expect(AgentProfiles.shape.verify.safeParse({ kind: "claude" }).success).toBe(true);
    expect(AgentProfiles.shape.verify.safeParse({ kind: "copilot" }).success).toBe(true);
  });

  it("verify shares the agent profile schema", () => {
    expect(AgentProfiles.shape.verify.unwrap()).toBe(VerifyAgentProfile);
    expect(ProjectUpdate.shape.agentProfiles.unwrap().shape.verify.unwrap()).toBe(
      VerifyAgentProfile,
    );
  });

  it("rejects unknown phases and an empty model", () => {
    expect(AgentProfiles.safeParse({ review: { kind: "claude" } }).success).toBe(false);
    expect(AgentProfiles.safeParse({ refine: { kind: "claude", model: "" } }).success).toBe(false);
  });
});

describe("ProjectLimits", () => {
  it("accepts empty limits", () => {
    expect(ProjectLimits.parse({})).toEqual({});
  });

  it("accepts concurrency, per-phase timeout and iteration cap", () => {
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
  ])("rejects %j", (limits) => {
    expect(ProjectLimits.safeParse(limits).success).toBe(false);
  });
});

describe("ProjectCreate", () => {
  it("applies defaults for profiles and limits", () => {
    const project = ProjectCreate.parse(validCreate);
    expect(project.agentProfiles.verify).toEqual({ kind: "claude", args: [] });
    expect(project.limits).toEqual({});
    expect(project.testCommand).toBeUndefined();
  });

  it("accepts test command and bootstrap", () => {
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
    ["relative path", { localPath: "workspace/lunas-queue" }],
    ["empty branch", { baseBranch: "" }],
    ["empty name", { name: " " }],
    ["empty test command", { testCommand: "" }],
    ["verify with another kind", { agentProfiles: { verify: { kind: "codex" } } }],
  ])("rejects %s", (_label, overrides) => {
    expect(ProjectCreate.safeParse({ ...validCreate, ...overrides }).success).toBe(false);
  });

  it("rejects unknown fields", () => {
    expect(ProjectCreate.safeParse({ ...validCreate, id: "x" }).success).toBe(false);
  });
});

describe("ProjectUpdate", () => {
  it("is partial and applies no defaults", () => {
    expect(ProjectUpdate.parse({ baseBranch: "develop" })).toEqual({ baseBranch: "develop" });
  });

  it("allows deleting the test command and bootstrap with null", () => {
    expect(ProjectUpdate.parse({ testCommand: null, bootstrap: null })).toEqual({
      testCommand: null,
      bootstrap: null,
    });
  });

  it("validates the verify profile", () => {
    const result = ProjectUpdate.safeParse({ agentProfiles: { verify: { kind: "codex" } } });
    expect(result.success).toBe(false);
  });
});

describe("Project", () => {
  it("includes id and timestamps", () => {
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

describe("normalization and format", () => {
  it.each(["/r/a/", "/r/./a", "//r//a", "/r/b/../a"])("normaliza %s a /r/a", (localPath) => {
    expect(ProjectCreate.parse({ ...validCreate, localPath }).localPath).toBe("/r/a");
  });

  it.each(["/", "/..", "/./"])("rejects the root (%s)", (localPath) => {
    expect(ProjectCreate.safeParse({ ...validCreate, localPath }).success).toBe(false);
  });

  it("accepts owners with an underscore", () => {
    expect(ProjectCreate.safeParse({ ...validCreate, repo: "user_corp/repo.js" }).success).toBe(
      true,
    );
  });

  it.each(["-x/y", "x/..", "x/.", "_x/y"])("rejects the repo %s", (repo) => {
    expect(ProjectCreate.safeParse({ ...validCreate, repo }).success).toBe(false);
  });

  it("limits the phase timeout to one week", () => {
    const at = (minutes: number) =>
      ProjectLimits.safeParse({ phaseTimeoutMinutes: { implement: minutes } }).success;
    expect(at(MAX_PHASE_TIMEOUT_MINUTES)).toBe(true);
    expect(at(MAX_PHASE_TIMEOUT_MINUTES + 1)).toBe(false);
  });

  it("the PATCH of agentProfiles is partial per phase and without defaults", () => {
    const patch = ProjectUpdate.parse({
      agentProfiles: { verify: { kind: "claude", model: "sonnet" } },
    });
    expect(patch.agentProfiles).toEqual({ verify: { kind: "claude", model: "sonnet", args: [] } });
  });
});
