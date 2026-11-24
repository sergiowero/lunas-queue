import { type AgentProfileReader, InMemoryAgentProfileReader } from "@lunasq/domain";
import { PROFILE_COLORS, PROFILE_ICONS } from "@lunasq/schemas";
import { describe, expect, it } from "vitest";
import { AgentProfileRepository, AgentProfileRepositoryError } from "./agent-profiles.ts";
import { ProjectRepository } from "./projects.ts";
import { agentProfiles, events, outbox } from "./schema.ts";
import { migratedDatabase } from "./test-helpers.ts";

const fastModels = [
  { kind: "claude" as const, model: "opus" },
  { kind: "codex" as const, model: "gpt-5" },
];

function repository() {
  const db = migratedDatabase();
  return { db, repo: new AgentProfileRepository(db) };
}

function errorOf(fn: () => unknown): AgentProfileRepositoryError {
  try {
    fn();
  } catch (error) {
    if (error instanceof AgentProfileRepositoryError) return error;
    throw error;
  }
  throw new Error("it did not throw");
}

const eventTypes = (db: ReturnType<typeof migratedDatabase>) =>
  db.select({ type: events.type, taskId: events.taskId }).from(events).all();

describe("AgentProfileRepository.create", () => {
  it("stores the profile with its models in order and records agent_profile.created", () => {
    const { db, repo } = repository();
    const profile = repo.create({ name: "Fast", models: fastModels });
    expect(profile.models.map((m) => [m.kind, m.model])).toEqual([
      ["claude", "opus"],
      ["codex", "gpt-5"],
    ]);
    expect(profile.models.every((m) => Array.isArray(m.args))).toBe(true);
    expect(repo.get(profile.id)).toEqual(profile);
    expect(repo.list().map((p) => p.name)).toEqual(["Fast"]);
    // A global event (no task) that also enters the outbox so the scheduler wakes.
    const created = db.select().from(events).all();
    expect(created).toMatchObject([
      {
        type: "agent_profile.created",
        taskId: null,
        payload: { profileId: profile.id, name: "Fast" },
      },
    ]);
    expect(db.select().from(outbox).all()).toHaveLength(1);
  });

  it("rejects a repeated name, with 0 or more than 10 models, storing nothing", () => {
    const { db, repo } = repository();
    repo.create({ name: "Fast", models: fastModels });
    expect(errorOf(() => repo.create({ name: "Fast", models: fastModels }))).toMatchObject({
      code: "conflict",
    });
    expect(() => repo.create({ name: "Empty", models: [] })).toThrow();
    expect(() =>
      repo.create({
        name: "Big",
        models: Array.from({ length: 11 }, () => ({ kind: "claude" as const })),
      }),
    ).toThrow();
    expect(db.select().from(agentProfiles).all()).toHaveLength(1);
    expect(eventTypes(db)).toHaveLength(1);
  });

  it("rejects a model that carries effort and --effort", () => {
    const { repo } = repository();
    expect(() =>
      repo.create({
        name: "Bad",
        models: [{ kind: "claude", effort: "high", args: ["--effort", "low"] }],
      }),
    ).toThrow(/--effort/);
  });
});

describe("AgentProfileRepository appearance", () => {
  it("assigns the icon and color of the random source when the create request has none", () => {
    const db = migratedDatabase();
    const repo = new AgentProfileRepository(db, () => 0.5);
    const profile = repo.create({ name: "Fast", models: fastModels });
    expect(profile.icon).toBe(PROFILE_ICONS[Math.floor(0.5 * PROFILE_ICONS.length)]);
    expect(profile.color).toBe(PROFILE_COLORS[Math.floor(0.5 * PROFILE_COLORS.length)]);
    expect(repo.get(profile.id)).toMatchObject({ icon: profile.icon, color: profile.color });
    expect(eventTypes(db).map((e) => e.type)).toEqual(["agent_profile.created"]);
  });

  it("keeps the chosen icon and only draws the missing color", () => {
    const repo = new AgentProfileRepository(migratedDatabase(), () => 0);
    const profile = repo.create({ name: "Fast", models: fastModels, icon: "leaf" });
    expect(profile).toMatchObject({ icon: "leaf", color: PROFILE_COLORS[0] });
    const both = repo.create({ name: "Slow", models: fastModels, icon: "rocket", color: "pink" });
    expect(both).toMatchObject({ icon: "rocket", color: "pink" });
  });

  it("updating only the color changes it, keeps icon, name and models and publishes agent_profile.updated", () => {
    const { db, repo } = repository();
    const profile = repo.create({ name: "Fast", models: fastModels, icon: "bolt", color: "red" });
    const updated = repo.update(profile.id, { color: "teal" });
    expect(updated).toMatchObject({
      icon: "bolt",
      color: "teal",
      name: "Fast",
      models: profile.models,
    });
    expect(repo.get(profile.id)?.color).toBe("teal");
    expect(eventTypes(db).map((e) => e.type)).toEqual([
      "agent_profile.created",
      "agent_profile.updated",
    ]);
  });

  it("an update without icon or color keeps the stored ones", () => {
    const { repo } = repository();
    const profile = repo.create({
      name: "Fast",
      models: fastModels,
      icon: "flask",
      color: "amber",
    });
    const updated = repo.update(profile.id, { name: "Faster" });
    expect(updated).toMatchObject({ name: "Faster", icon: "flask", color: "amber" });
    expect(repo.get(profile.id)).toMatchObject({ icon: "flask", color: "amber" });
  });

  it("an update that repeats the stored appearance writes and publishes nothing", () => {
    const { db, repo } = repository();
    const profile = repo.create({
      name: "Fast",
      models: fastModels,
      icon: "flask",
      color: "amber",
    });
    expect(repo.update(profile.id, { icon: "flask", color: "amber" })).toEqual(profile);
    expect(eventTypes(db)).toHaveLength(1);
  });

  it("rejects an icon or color outside the sets and stores nothing", () => {
    const { db, repo } = repository();
    expect(() =>
      repo.create({ name: "Fast", models: fastModels, icon: "star" as never }),
    ).toThrow();
    const profile = repo.create({ name: "Ok", models: fastModels });
    expect(() => repo.update(profile.id, { color: "beige" as never })).toThrow();
    expect(repo.list()).toHaveLength(1);
    expect(repo.get(profile.id)?.color).toBe(profile.color);
    expect(eventTypes(db)).toHaveLength(1);
  });
});

describe("AgentProfileRepository.update", () => {
  it("replaces the present fields and records agent_profile.updated", () => {
    const { db, repo } = repository();
    const profile = repo.create({ name: "Fast", models: fastModels });
    const updated = repo.update(profile.id, {
      name: "Faster",
      models: [{ kind: "copilot", model: "gpt-5" }, ...fastModels],
    });
    expect(updated?.name).toBe("Faster");
    expect(updated?.models.map((m) => m.kind)).toEqual(["copilot", "claude", "codex"]);
    expect(eventTypes(db).map((e) => e.type)).toEqual([
      "agent_profile.created",
      "agent_profile.updated",
    ]);
  });

  it("a patch that changes nothing writes and publishes nothing", () => {
    const { db, repo } = repository();
    const profile = repo.create({ name: "Fast", models: fastModels });
    expect(repo.update(profile.id, { name: "Fast", models: profile.models })).toEqual(profile);
    expect(repo.update(profile.id, {})).toEqual(profile);
    expect(eventTypes(db)).toHaveLength(1);
  });

  it("returns null if it does not exist and conflicts on a repeated name", () => {
    const { repo } = repository();
    expect(repo.update(crypto.randomUUID(), { name: "X" })).toBeNull();
    repo.create({ name: "A", models: fastModels });
    const b = repo.create({ name: "B", models: fastModels });
    expect(errorOf(() => repo.update(b.id, { name: "A" }))).toMatchObject({ code: "conflict" });
    expect(repo.get(b.id)?.name).toBe("B");
  });
});

describe("AgentProfileRepository.delete", () => {
  it("removes an unused profile and records agent_profile.deleted", () => {
    const { db, repo } = repository();
    const profile = repo.create({ name: "Fast", models: fastModels });
    expect(repo.delete(profile.id)).toBe(true);
    expect(repo.get(profile.id)).toBeNull();
    expect(eventTypes(db).map((e) => e.type)).toEqual([
      "agent_profile.created",
      "agent_profile.deleted",
    ]);
    expect(repo.delete(profile.id)).toBe(false);
  });

  it("rejects deleting a profile a project uses, listing the project and phases", () => {
    const { db, repo } = repository();
    const profile = repo.create({ name: "Fast", models: fastModels });
    const project = new ProjectRepository(db).create({
      name: "alfa",
      repo: "o/alfa",
      baseBranch: "main",
      localPath: "/repos/alfa",
      agentProfiles: { implement: profile.id, verify: profile.id },
    });

    const error = errorOf(() => repo.delete(profile.id));

    expect(error.code).toBe("in_use");
    expect(error.usedBy).toEqual([
      { projectId: project.id, projectName: "alfa", phases: ["implement", "verify"] },
    ]);
    expect(repo.get(profile.id)).not.toBeNull();
    expect(repo.usage(profile.id)).toHaveLength(1);

    // Once the project unassigns it, the profile can be deleted.
    new ProjectRepository(db).update(project.id, {
      agentProfiles: { implement: null, verify: null },
    });
    expect(repo.delete(profile.id)).toBe(true);
  });
});

describe("AgentProfileReader contract", () => {
  const shapes: [string, () => { reader: AgentProfileReader; id: string }][] = [
    [
      "db",
      () => {
        const { repo } = repository();
        const profile = repo.create({ name: "Fast", models: fastModels });
        return { reader: repo, id: profile.id };
      },
    ],
    [
      "in memory",
      () => {
        const { repo } = repository();
        const profile = repo.create({ name: "Fast", models: fastModels });
        return { reader: new InMemoryAgentProfileReader([profile]), id: profile.id };
      },
    ],
  ];

  it.each(shapes)("%s: get and list return the stored profile", (_name, setup) => {
    const { reader, id } = setup();
    expect(reader.get(id)?.name).toBe("Fast");
    expect(reader.get(crypto.randomUUID())).toBeNull();
    expect(reader.list().map((p) => p.id)).toEqual([id]);
  });
});
