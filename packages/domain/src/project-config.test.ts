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
  it("devuelve el perfil configurado de la fase", () => {
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

  it("el approver de verificación usa Sonnet si el perfil no fija modelo", () => {
    expect(DEFAULT_VERIFY_MODEL).toBe("sonnet");
    expect(phaseProfile(project(), "verify")).toEqual({
      kind: "claude",
      model: "sonnet",
      args: [],
    });
    const opus = project({ agentProfiles: { verify: { kind: "claude", model: "opus" } } });
    expect(phaseProfile(opus, "verify").model).toBe("opus");
    expect(phaseProfile(project(), "implement").model).toBeUndefined();
  });
});

describe("maxVerificationIterations", () => {
  it("usa 3 si el proyecto no fija el tope", () => {
    expect(maxVerificationIterations(project())).toBe(DEFAULT_MAX_ITERATIONS);
    expect(DEFAULT_MAX_ITERATIONS).toBe(3);
  });

  it("respeta el tope del proyecto", () => {
    const config = project({ limits: { maxVerificationIterations: 5 } });
    expect(maxVerificationIterations(config)).toBe(5);
  });
});

describe("phaseTimeoutMs", () => {
  it("usa 30 minutos si la fase no tiene timeout propio", () => {
    expect(DEFAULT_PHASE_TIMEOUT_MINUTES).toBe(30);
    expect(phaseTimeoutMs(project(), "implement")).toBe(30 * 60_000);
  });

  it("respeta el timeout configurado por fase", () => {
    const config = project({ limits: { phaseTimeoutMinutes: { implement: 90 } } });
    expect(phaseTimeoutMs(config, "implement")).toBe(90 * 60_000);
    expect(phaseTimeoutMs(config, "verify")).toBe(30 * 60_000);
  });
});

describe("un consumidor lee la configuración sin tocar la base", () => {
  // Así la leerán el dispatcher, el gate de tests y los hooks: solo con el puerto.
  function launchPlan(reader: ProjectConfigReader, projectId: string, phase: Phase) {
    const config = reader.get(projectId);
    if (!config) return null;
    return {
      cwd: config.localPath,
      profile: phaseProfile(config, phase),
      timeoutMs: phaseTimeoutMs(config, phase),
    };
  }

  it("resuelve perfil y timeout desde un reader en memoria", () => {
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

projectConfigReaderContract("en memoria", (configs) => new InMemoryProjectConfigReader(configs));
