import type { Phase, ProjectCreate } from "@lunasq/schemas";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_PHASE_TIMEOUT_MINUTES,
  DEFAULT_VERIFY_MODEL,
  InMemoryProjectConfigReader,
  maxVerificationIterations,
  type ProjectConfigReader,
  phaseProfile,
  phaseTimeoutMs,
} from "./index.ts";
import { fakeUuid, projectConfigReaderContract, sampleProject } from "./testing.ts";

const project = (overrides: Partial<ProjectCreate> = {}) => sampleProject("lunas-queue", overrides);

describe("phaseProfile", () => {
  it("returns the configured profile of the phase", () => {
    const config = project({
      agentProfiles: { verify: { kind: "claude", model: "sonnet", args: ["--x"] } },
    });
    expect(phaseProfile(config, "verify")).toEqual({
      kind: "claude",
      model: "sonnet",
      args: ["--x"],
    });
    expect(phaseProfile(config, "refine")).toEqual({ kind: "claude", args: [] });
  });

  it("the verification approver uses Sonnet if the profile sets no model", () => {
    expect(DEFAULT_VERIFY_MODEL).toBe("sonnet");
    expect(phaseProfile(project(), "verify")).toEqual({
      kind: "claude",
      model: "sonnet",
      args: [],
    });
    const opus = project({ agentProfiles: { verify: { kind: "claude", model: "opus" } } });
    expect(phaseProfile(opus, "verify").model).toBe("opus");
    expect(phaseProfile(project(), "implement").model).toBeUndefined();
    const copilot = project({ agentProfiles: { verify: { kind: "copilot" } } });
    expect(phaseProfile(copilot, "verify")).toEqual({ kind: "copilot", args: [] });
  });
});

describe("maxVerificationIterations", () => {
  it("uses 5 if neither the project nor Settings set a cap", () => {
    expect(maxVerificationIterations(project())).toBe(DEFAULT_MAX_ITERATIONS);
    expect(maxVerificationIterations(project(), undefined)).toBe(5);
    expect(DEFAULT_MAX_ITERATIONS).toBe(5);
  });

  it("uses the global cap if the project sets none", () => {
    expect(maxVerificationIterations(project(), 7)).toBe(7);
  });

  it("the project cap overrides the global cap", () => {
    const config = project({ limits: { maxVerificationIterations: 2 } });
    expect(maxVerificationIterations(config, 7)).toBe(2);
    expect(maxVerificationIterations(config)).toBe(2);
  });
});

describe("phaseTimeoutMs", () => {
  it("uses 30 minutes if the phase has no timeout of its own", () => {
    expect(DEFAULT_PHASE_TIMEOUT_MINUTES).toBe(30);
    expect(phaseTimeoutMs(project(), "implement")).toBe(30 * 60_000);
  });

  it("respects the timeout configured per phase", () => {
    const config = project({ limits: { phaseTimeoutMinutes: { implement: 90 } } });
    expect(phaseTimeoutMs(config, "implement")).toBe(90 * 60_000);
    expect(phaseTimeoutMs(config, "verify")).toBe(30 * 60_000);
  });
});

describe("a consumer reads the configuration without touching the database", () => {
  // This is how the dispatcher, the test gate and the hooks will read it: only through the port.
  function launchPlan(reader: ProjectConfigReader, projectId: string, phase: Phase) {
    const config = reader.get(projectId);
    if (!config) return null;
    return {
      cwd: config.localPath,
      profile: phaseProfile(config, phase),
      timeoutMs: phaseTimeoutMs(config, phase),
    };
  }

  it("resolves profile and timeout from an in-memory reader", () => {
    const config = project({
      agentProfiles: { implement: { kind: "claude", model: "opus" } },
      limits: { phaseTimeoutMinutes: { implement: 45 } },
    });
    const reader = new InMemoryProjectConfigReader([config]);
    expect(launchPlan(reader, config.id, "implement")).toEqual({
      cwd: "/repos/lunas-queue",
      profile: { kind: "claude", model: "opus", args: [] },
      timeoutMs: 45 * 60_000,
    });
    expect(launchPlan(reader, fakeUuid(), "implement")).toBeNull();
  });
});

projectConfigReaderContract("in memory", (configs) => new InMemoryProjectConfigReader(configs));
