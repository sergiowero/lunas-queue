// Contract suites of the domain ports: they run against the in-memory implementation and
// against the @lunasq/db one, so that both behave the same.
import {
  Project,
  ProjectCreate,
  type PrState,
  type ResultKind,
  type SubState,
  type TaskState,
} from "@lunasq/schemas";
import { describe, expect, it } from "vitest";
import type { DependencyEdge, DependencyGraphReader } from "./dependency-graph.ts";
import type { ProjectConfigReader } from "./project-config.ts";
import type { SchedulerStateReader } from "./scheduler.ts";

let seq = 0;

/** Valid and deterministic UUID v4 (domain has no `crypto`). */
export function fakeUuid(): string {
  seq += 1;
  return `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
}

/** Complete and validated project, as a ProjectConfigReader returns it. */
export function sampleProject(name: string, overrides: Partial<ProjectCreate> = {}): Project {
  const now = new Date();
  return Project.parse({
    testCommand: null,
    bootstrap: null,
    ...ProjectCreate.parse({
      name,
      repo: `sergiowero/${name}`,
      baseBranch: "main",
      localPath: `/repos/${name}`,
      ...overrides,
    }),
    id: fakeUuid(),
    createdAt: now,
    updatedAt: now,
  });
}

export function projectConfigReaderContract(
  name: string,
  setup: (configs: Project[]) => ProjectConfigReader,
): void {
  describe(`ProjectConfigReader contract: ${name}`, () => {
    it("returns the complete configuration of a project", () => {
      const config = sampleProject("beta", {
        agentProfiles: { verify: { kind: "claude", model: "sonnet", args: ["--x"] } },
        limits: { concurrency: 2, phaseTimeoutMinutes: { implement: 60 } },
        testCommand: "pnpm test",
        bootstrap: "pnpm install",
      });
      const reader = setup([config]);
      expect(reader.get(config.id)).toEqual(config);
    });

    it("returns null if the project does not exist", () => {
      const reader = setup([sampleProject("alfa")]);
      expect(reader.get(fakeUuid())).toBeNull();
    });

    it("lists the projects ordered by name", () => {
      const reader = setup([sampleProject("gamma"), sampleProject("alfa"), sampleProject("beta")]);
      expect(reader.list().map((p) => p.name)).toEqual(["alfa", "beta", "gamma"]);
    });

    it("changing what was read does not change the configuration", () => {
      const config = sampleProject("alfa");
      const reader = setup([config]);
      const read = reader.get(config.id);
      if (!read) throw new Error("no project");
      read.agentProfiles.refine.args.push("--mutado");
      read.createdAt.setFullYear(1990);
      expect(reader.get(config.id)?.agentProfiles.refine.args).toEqual([]);
      expect(reader.get(config.id)?.createdAt).toEqual(config.createdAt);
    });
  });
}

/**
 * Contract suite of DependencyGraphReader: runs against the in-memory reader and against the
 * task repository of @lunasq/db. Edges use names; `setup` creates one task per
 * name and returns the reader and how to translate a name to its id.
 */
export function dependencyGraphReaderContract(
  name: string,
  setup: (edges: DependencyEdge[]) => {
    reader: DependencyGraphReader;
    idOf: (name: string) => string;
  },
): void {
  describe(`DependencyGraphReader contract: ${name}`, () => {
    it("the snapshot reflects all the edges", () => {
      const { reader, idOf } = setup([
        { taskId: "b", dependsOnId: "a" },
        { taskId: "c", dependsOnId: "b" },
      ]);
      const graph = reader.snapshot();
      expect(graph.edges()).toHaveLength(2);
      expect(graph.ancestors(idOf("c"))).toEqual([idOf("b"), idOf("a")]);
      expect(graph.descendants(idOf("a"))).toEqual([idOf("b"), idOf("c")]);
    });

    it("without edges returns an empty graph", () => {
      const graph = setup([]).reader.snapshot();
      expect(graph.edges()).toEqual([]);
    });
  });
}

/** Task seeded for the SchedulerStateReader suite; omitted fields take their default. */
export type SchedulerSeed = {
  name: string;
  state: TaskState;
  subState?: SubState | null;
  priority?: number;
  prState?: PrState | null;
  resultKind?: ResultKind | null;
};

/**
 * Contract suite of SchedulerStateReader: runs against the in-memory reader and against the one of
 * @lunasq/db. `setup` creates the tasks and edges by name (sub-state null by default) and
 * returns the reader and how to translate a name to its id. readySince is computed by each
 * implementation and tested separately.
 */
export function schedulerStateReaderContract(
  name: string,
  setup: (
    tasks: SchedulerSeed[],
    edges: DependencyEdge[],
  ) => { reader: SchedulerStateReader; idOf: (name: string) => string },
): void {
  describe(`SchedulerStateReader contract: ${name}`, () => {
    it("returns the live tasks with their state, sub-state, priority and PR", () => {
      const { reader, idOf } = setup(
        [
          { name: "a", state: "draft", subState: "queued", priority: 300 },
          { name: "b", state: "in_progress", subState: "running" },
          { name: "c", state: "refined" },
          { name: "d", state: "needs_human" },
        ],
        [],
      );
      const byId = new Map(reader.snapshot().tasks.map((t) => [t.id, t]));
      expect(byId.size).toBe(4);
      expect(byId.get(idOf("a"))).toMatchObject({
        state: "draft",
        subState: "queued",
        priority: 300,
        prState: null,
      });
      expect(byId.get(idOf("b"))).toMatchObject({ state: "in_progress", subState: "running" });
      for (const t of byId.values()) {
        expect(t.createdAt).toBeInstanceOf(Date);
        expect(t.readySince).toBeInstanceOf(Date);
      }
    });

    it("includes the terminal ones that are a dependency of a live one and omits the rest", () => {
      const { reader, idOf } = setup(
        [
          { name: "hecha", state: "completed", prState: "merged" },
          { name: "cancelada", state: "cancelled" },
          { name: "suelta", state: "completed", prState: "merged" },
          { name: "fin", state: "completed", prState: "merged" },
          { name: "viva", state: "draft", subState: "queued" },
        ],
        [
          { taskId: "viva", dependsOnId: "hecha" },
          { taskId: "viva", dependsOnId: "cancelada" },
          { taskId: "fin", dependsOnId: "suelta" },
        ],
      );
      const snapshot = reader.snapshot();
      expect(snapshot.tasks.map((t) => t.id).sort()).toEqual(
        [idOf("hecha"), idOf("cancelada"), idOf("viva")].sort(),
      );
      expect(snapshot.tasks.find((t) => t.id === idOf("hecha"))?.prState).toBe("merged");
      // Only the edges of the live tasks: the terminal ones no longer wait for anything.
      expect(snapshot.edges).toHaveLength(2);
      expect(snapshot.edges).toEqual(
        expect.arrayContaining([
          { taskId: idOf("viva"), dependsOnId: idOf("hecha") },
          { taskId: idOf("viva"), dependsOnId: idOf("cancelada") },
        ]),
      );
    });

    it("exposes the Result of a dependency completed without a PR", () => {
      const { reader, idOf } = setup(
        [
          { name: "investigada", state: "completed", resultKind: "research" },
          { name: "viva", state: "draft", subState: "queued" },
        ],
        [{ taskId: "viva", dependsOnId: "investigada" }],
      );
      const dep = reader.snapshot().tasks.find((t) => t.id === idOf("investigada"));
      expect(dep).toMatchObject({ state: "completed", prState: null, resultKind: "research" });
    });

    it("changing the snapshot does not change the next one", () => {
      const { reader } = setup(
        [{ name: "a", state: "draft", subState: "queued", priority: 100 }],
        [],
      );
      const first = reader.snapshot();
      const t = first.tasks[0];
      if (!t) throw new Error("no tasks");
      t.priority = 999;
      t.createdAt.setFullYear(1990);
      first.edges.push({ taskId: "x", dependsOnId: "y" });
      const second = reader.snapshot();
      expect(second.tasks[0]?.priority).toBe(100);
      expect(second.tasks[0]?.createdAt.getFullYear()).not.toBe(1990);
      expect(second.edges).toEqual([]);
    });
  });
}
