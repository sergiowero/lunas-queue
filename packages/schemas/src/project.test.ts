import { describe, expect, it } from "vitest";
import {
  AgentProfileCreate,
  AgentProfileUpdate,
  MAX_PHASE_TIMEOUT_MINUTES,
  PhaseProfiles,
  PROJECT_COLORS,
  PROJECT_ICONS,
  ProfileModel,
  Project,
  ProjectColor,
  ProjectCreate,
  ProjectIcon,
  ProjectLimits,
  ProjectUpdate,
  unassignedPhases,
} from "./index.ts";

const validCreate = {
  name: "lunas-queue",
  repo: "sergiowero/lunas-queue",
  baseBranch: "main",
  localPath: "/Users/sergio/workspace/lunas-queue",
};

const uuid = () => crypto.randomUUID();

describe("ProfileModel", () => {
  it("accepts effort only with the levels of claude --effort", () => {
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
      expect(ProfileModel.parse({ kind: "claude", effort }).effort).toBe(effort);
    }
    expect(ProfileModel.safeParse({ kind: "claude", effort: "turbo" }).success).toBe(false);
  });

  it("keeps the provider, model and args, with empty args by default", () => {
    expect(ProfileModel.parse({ kind: "claude" })).toEqual({ kind: "claude", args: [] });
    expect(ProfileModel.parse({ kind: "codex", model: "gpt-5", args: ["--x"] })).toEqual({
      kind: "codex",
      model: "gpt-5",
      args: ["--x"],
    });
  });

  it("accepts Claude, Copilot and Codex and rejects other providers or an empty model", () => {
    for (const kind of ["claude", "copilot", "codex"]) {
      expect(ProfileModel.safeParse({ kind }).success).toBe(true);
    }
    expect(ProfileModel.safeParse({ kind: "gemini" }).success).toBe(false);
    expect(ProfileModel.safeParse({ kind: "claude", model: "" }).success).toBe(false);
  });

  it("rejects effort together with --effort in args, naming the flag", () => {
    for (const args of [["--effort", "low"], ["--effort=low"]]) {
      const result = ProfileModel.safeParse({ kind: "claude", effort: "high", args });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toContain("--effort");
    }
    // Without effort the flag in args is still allowed (existing behavior).
    expect(ProfileModel.safeParse({ kind: "claude", args: ["--effort", "low"] }).success).toBe(
      true,
    );
  });
});

describe("AgentProfileCreate", () => {
  const model = { kind: "claude" as const, model: "opus" };

  it("accepts a name and from 1 to 10 models, keeping their order", () => {
    const models = [model, { kind: "codex" as const, model: "gpt-5" }];
    const parsed = AgentProfileCreate.parse({ name: "Fast", models });
    expect(parsed.models.map((m) => m.kind)).toEqual(["claude", "codex"]);
    expect(
      AgentProfileCreate.safeParse({ name: "Max", models: Array.from({ length: 10 }, () => model) })
        .success,
    ).toBe(true);
  });

  it.each([
    ["no models", { name: "Fast", models: [] }],
    [
      "more than 10 models",
      { name: "Fast", models: Array.from({ length: 11 }, () => ({ kind: "claude" })) },
    ],
    ["an empty name", { name: "  ", models: [{ kind: "claude" }] }],
    ["unknown fields", { name: "Fast", models: [{ kind: "claude" }], id: uuid() }],
    [
      "a model with a conflicting effort flag",
      {
        name: "Fast",
        models: [{ kind: "claude", effort: "high", args: ["--effort", "low"] }],
      },
    ],
  ])("rejects %s", (_label, input) => {
    expect(AgentProfileCreate.safeParse(input).success).toBe(false);
  });

  it("the PATCH is partial", () => {
    expect(AgentProfileUpdate.parse({ name: "Slow" })).toEqual({ name: "Slow" });
    expect(AgentProfileUpdate.safeParse({ models: [] }).success).toBe(false);
  });
});

describe("PhaseProfiles", () => {
  it("leaves every phase unassigned by default", () => {
    expect(PhaseProfiles.parse({})).toEqual({
      refine: null,
      implement: null,
      verify: null,
      deliver: null,
    });
  });

  it("accepts profile ids or null and rejects anything else", () => {
    const id = uuid();
    expect(PhaseProfiles.parse({ implement: id }).implement).toBe(id);
    expect(PhaseProfiles.safeParse({ implement: "claude" }).success).toBe(false);
    expect(PhaseProfiles.safeParse({ review: id }).success).toBe(false);
  });

  it("lists the unassigned phases", () => {
    const id = uuid();
    expect(unassignedPhases(PhaseProfiles.parse({ implement: id, verify: id }))).toEqual([
      "refine",
      "deliver",
    ]);
    expect(
      unassignedPhases(PhaseProfiles.parse({ refine: id, implement: id, verify: id, deliver: id })),
    ).toEqual([]);
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
    expect(project.agentProfiles).toEqual({
      refine: null,
      implement: null,
      verify: null,
      deliver: null,
    });
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
    ["a phase profile that is not an id", { agentProfiles: { verify: { kind: "claude" } } }],
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

  it("validates the phase profiles", () => {
    const result = ProjectUpdate.safeParse({ agentProfiles: { verify: { kind: "claude" } } });
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
      icon: null,
      color: null,
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

  it("the PATCH of agentProfiles is partial per phase, without defaults, and null unassigns", () => {
    const id = uuid();
    const patch = ProjectUpdate.parse({ agentProfiles: { verify: id, deliver: null } });
    expect(patch.agentProfiles).toEqual({ verify: id, deliver: null });
  });
});

describe("project icon and color", () => {
  it("the icon set and the color palette are closed", () => {
    expect(PROJECT_ICONS).toEqual([
      "folder",
      "code",
      "terminal",
      "globe",
      "database",
      "server",
      "rocket",
      "book",
      "package",
      "mobile",
      "cloud",
      "bolt",
    ]);
    expect(PROJECT_COLORS).toEqual([
      "red",
      "orange",
      "amber",
      "green",
      "teal",
      "blue",
      "violet",
      "pink",
    ]);
    expect(ProjectIcon.safeParse("rocket").success).toBe(true);
    expect(ProjectColor.safeParse("teal").success).toBe(true);
  });

  it("a creation request keeps the icon and the color it brings", () => {
    const project = ProjectCreate.parse({ ...validCreate, icon: "rocket", color: "teal" });
    expect(project).toMatchObject({ icon: "rocket", color: "teal" });
  });

  it("a creation request without icon or color leaves them out", () => {
    const project = ProjectCreate.parse(validCreate);
    expect(project.icon).toBeUndefined();
    expect(project.color).toBeUndefined();
  });

  it("icon and color are independent: each can be set without the other", () => {
    expect(ProjectCreate.parse({ ...validCreate, icon: "book" }).color).toBeUndefined();
    expect(ProjectCreate.parse({ ...validCreate, color: "blue" }).icon).toBeUndefined();
  });

  it.each([
    ["icon", { icon: "unicorn" }],
    ["color", { color: "#ff0000" }],
  ])("rejects a creation request with a %s outside its set, at that path", (path, overrides) => {
    const result = ProjectCreate.safeParse({ ...validCreate, ...overrides });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path[0])).toContain(path);
  });

  it.each([
    ["icon", { icon: "unicorn" }],
    ["color", { color: "#ff0000" }],
  ])("rejects an update with a %s outside its set, at that path", (path, patch) => {
    const result = ProjectUpdate.safeParse(patch);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path[0])).toContain(path);
  });

  it("an update with color null clears it and leaves the icon out", () => {
    expect(ProjectUpdate.parse({ color: null })).toEqual({ color: null });
  });

  it("an update with only an icon leaves the color out", () => {
    expect(ProjectUpdate.parse({ icon: "database" })).toEqual({ icon: "database" });
  });

  it("a stored project has a nullable icon and color, never undefined", () => {
    const now = new Date();
    const base = {
      ...ProjectCreate.parse(validCreate),
      id: crypto.randomUUID(),
      testCommand: null,
      bootstrap: null,
      createdAt: now,
      updatedAt: now,
    };
    expect(Project.parse({ ...base, icon: null, color: null })).toMatchObject({
      icon: null,
      color: null,
    });
    expect(Project.safeParse(base).success).toBe(false);
    expect(Project.safeParse({ ...base, icon: "unicorn", color: null }).success).toBe(false);
  });
});
