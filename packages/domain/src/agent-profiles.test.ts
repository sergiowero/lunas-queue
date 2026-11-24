import type { AgentProviderSettings } from "@lunasq/schemas";
import { describe, expect, it } from "vitest";
import {
  InMemoryAgentProfileReader,
  phaseProfileId,
  resolvePhaseModel,
  resolveProjectPhase,
} from "./agent-profiles.ts";
import { fakeUuid, sampleProfile, sampleProject } from "./testing.ts";

const all: AgentProviderSettings = { claude: true, copilot: true, codex: true, opencode: true };
const profile = sampleProfile("Fast", [
  { kind: "claude", model: "opus" },
  { kind: "codex", model: "gpt-5" },
  { kind: "copilot", model: "gpt-5" },
]);

describe("resolvePhaseModel", () => {
  it("the effective model is the primary when everything is enabled", () => {
    expect(resolvePhaseModel("implement", profile, all)).toEqual({
      status: "ready",
      profileId: profile.id,
      index: 0,
      model: { kind: "claude", model: "opus", args: [] },
    });
  });

  it("skips models of disabled providers and keeps the index of the profile list", () => {
    const resolved = resolvePhaseModel("implement", profile, { ...all, claude: false });
    expect(resolved).toMatchObject({ status: "ready", index: 1 });
    const third = resolvePhaseModel("implement", profile, { ...all, claude: false, codex: false });
    expect(third).toMatchObject({ status: "ready", index: 2 });
  });

  it("skips exhausted models, each one at most once per phase dispatch", () => {
    expect(resolvePhaseModel("implement", profile, all, [0])).toMatchObject({ index: 1 });
    expect(resolvePhaseModel("implement", profile, all, [0, 1])).toMatchObject({ index: 2 });
    expect(resolvePhaseModel("implement", profile, all, new Set([0, 1, 2]))).toEqual({
      status: "exhausted",
    });
  });

  it("is exhausted when only the disabled ones were not tried", () => {
    expect(resolvePhaseModel("implement", profile, { ...all, copilot: false }, [0, 1])).toEqual({
      status: "exhausted",
    });
  });

  it("reports providers_disabled when every model belongs to a disabled provider", () => {
    expect(
      resolvePhaseModel("implement", profile, {
        claude: false,
        copilot: false,
        codex: false,
        opencode: false,
      }),
    ).toEqual({ status: "providers_disabled" });
  });

  it("an absent profile is an unassigned phase", () => {
    expect(resolvePhaseModel("refine", null, all)).toEqual({ status: "unassigned" });
    expect(resolvePhaseModel("refine", undefined, all)).toEqual({ status: "unassigned" });
  });

  it("verification runs on sonnet when the effective model is claude without a model", () => {
    const bare = sampleProfile("Bare", [{ kind: "claude" }]);
    expect(resolvePhaseModel("verify", bare, all)).toMatchObject({
      model: { kind: "claude", model: "sonnet" },
    });
    // Another phase keeps the provider default; an explicit model and other providers are untouched.
    expect(resolvePhaseModel("implement", bare, all)).toMatchObject({ model: { kind: "claude" } });
    const opus = sampleProfile("Opus", [{ kind: "claude", model: "opus" }]);
    expect(resolvePhaseModel("verify", opus, all)).toMatchObject({ model: { model: "opus" } });
    const copilot = sampleProfile("Copilot", [{ kind: "copilot" }]);
    expect(resolvePhaseModel("verify", copilot, all)).toMatchObject({
      model: { kind: "copilot", args: [] },
    });
  });
});

describe("resolveProjectPhase", () => {
  const reader = new InMemoryAgentProfileReader([profile]);

  it("resolves the profile the project selected for the phase", () => {
    const project = sampleProject("alfa", {
      agentProfiles: { implement: profile.id, refine: null },
    });
    expect(phaseProfileId(project, "implement")).toBe(profile.id);
    expect(resolveProjectPhase(project, "implement", reader, all)).toMatchObject({
      status: "ready",
      profileId: profile.id,
    });
    expect(resolveProjectPhase(project, "refine", reader, all)).toEqual({ status: "unassigned" });
  });

  it("a profile id that no longer exists counts as unassigned", () => {
    const project = sampleProject("beta", { agentProfiles: { implement: fakeUuid() } });
    expect(resolveProjectPhase(project, "implement", reader, all)).toEqual({
      status: "unassigned",
    });
  });
});

describe("InMemoryAgentProfileReader", () => {
  it("lists by name and returns copies", () => {
    const zeta = sampleProfile("Zeta");
    const alfa = sampleProfile("Alfa");
    const reader = new InMemoryAgentProfileReader([zeta, alfa]);
    expect(reader.list().map((p) => p.name)).toEqual(["Alfa", "Zeta"]);
    const read = reader.get(alfa.id);
    if (!read) throw new Error("no profile");
    read.models[0]?.args.push("--mutated");
    read.models.pop();
    expect(reader.get(alfa.id)?.models).toEqual(alfa.models);
    expect(reader.get(fakeUuid())).toBeNull();
  });
});
