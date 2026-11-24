import type { Phase, ProjectCreate } from "@lunasq/schemas";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_PHASE_TIMEOUT_MINUTES,
  InMemoryProjectConfigReader,
  maxVerificationIterations,
  type ProjectConfigReader,
  phaseProfileId,
  phaseTimeoutMs,
} from "./index.ts";
import {
  DEFAULT_SAMPLE_PROFILE,
  fakeUuid,
  projectConfigReaderContract,
  sampleProject,
} from "./testing.ts";

const project = (overrides: Partial<ProjectCreate> = {}) => sampleProject("lunas-queue", overrides);

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
      profileId: phaseProfileId(config, phase),
      timeoutMs: phaseTimeoutMs(config, phase),
    };
  }

  it("resolves profile id and timeout from an in-memory reader", () => {
    const config = project({
      agentProfiles: { implement: DEFAULT_SAMPLE_PROFILE.id },
      limits: { phaseTimeoutMinutes: { implement: 45 } },
    });
    const reader = new InMemoryProjectConfigReader([config]);
    expect(launchPlan(reader, config.id, "implement")).toEqual({
      cwd: "/repos/lunas-queue",
      profileId: DEFAULT_SAMPLE_PROFILE.id,
      timeoutMs: 45 * 60_000,
    });
    expect(launchPlan(reader, fakeUuid(), "implement")).toBeNull();
  });
});

projectConfigReaderContract("in memory", (configs) => new InMemoryProjectConfigReader(configs));
