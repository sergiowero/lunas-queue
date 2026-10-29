// Suites de contrato de los puertos del dominio: corren contra la implementación en memoria y
// contra la de @lunasq/db, para que ambas se comporten igual.
import {
  Project,
  ProjectCreate,
  type PrState,
  type SubState,
  type TaskState,
} from "@lunasq/schemas";
import { describe, expect, it } from "vitest";
import type { DependencyEdge, DependencyGraphReader } from "./dependency-graph.ts";
import type { ProjectConfigReader } from "./project-config.ts";
import type { SchedulerStateReader } from "./scheduler.ts";

let seq = 0;

/** UUID v4 válido y determinístico (domain no tiene `crypto`). */
export function fakeUuid(): string {
  seq += 1;
  return `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
}

/** Proyecto completo y validado, como lo devuelve un ProjectConfigReader. */
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
  describe(`contrato de ProjectConfigReader: ${name}`, () => {
    it("devuelve la configuración completa de un proyecto", () => {
      const config = sampleProject("beta", {
        agentProfiles: { verify: { kind: "claude", model: "sonnet", args: ["--x"] } },
        limits: { concurrency: 2, phaseTimeoutMinutes: { implement: 60 } },
        testCommand: "pnpm test",
        bootstrap: "pnpm install",
      });
      const reader = setup([config]);
      expect(reader.get(config.id)).toEqual(config);
    });

    it("devuelve null si el proyecto no existe", () => {
      const reader = setup([sampleProject("alfa")]);
      expect(reader.get(fakeUuid())).toBeNull();
    });

    it("lista los proyectos ordenados por nombre", () => {
      const reader = setup([sampleProject("gamma"), sampleProject("alfa"), sampleProject("beta")]);
      expect(reader.list().map((p) => p.name)).toEqual(["alfa", "beta", "gamma"]);
    });

    it("modificar lo leído no cambia la configuración", () => {
      const config = sampleProject("alfa");
      const reader = setup([config]);
      const read = reader.get(config.id);
      if (!read) throw new Error("sin proyecto");
      read.agentProfiles.refine.args.push("--mutado");
      read.createdAt.setFullYear(1990);
      expect(reader.get(config.id)?.agentProfiles.refine.args).toEqual([]);
      expect(reader.get(config.id)?.createdAt).toEqual(config.createdAt);
    });
  });
}

/**
 * Suite de contrato de DependencyGraphReader: corre contra el reader en memoria y contra el
 * repositorio de tareas de @lunasq/db. Las aristas usan nombres; `setup` crea una tarea por
 * nombre y devuelve el reader y cómo traducir un nombre a su id.
 */
export function dependencyGraphReaderContract(
  name: string,
  setup: (edges: DependencyEdge[]) => {
    reader: DependencyGraphReader;
    idOf: (name: string) => string;
  },
): void {
  describe(`contrato de DependencyGraphReader: ${name}`, () => {
    it("el snapshot refleja todas las aristas", () => {
      const { reader, idOf } = setup([
        { taskId: "b", dependsOnId: "a" },
        { taskId: "c", dependsOnId: "b" },
      ]);
      const graph = reader.snapshot();
      expect(graph.edges()).toHaveLength(2);
      expect(graph.ancestors(idOf("c"))).toEqual([idOf("b"), idOf("a")]);
      expect(graph.descendants(idOf("a"))).toEqual([idOf("b"), idOf("c")]);
    });

    it("sin aristas devuelve un grafo vacío", () => {
      const graph = setup([]).reader.snapshot();
      expect(graph.edges()).toEqual([]);
    });
  });
}

/** Tarea sembrada para la suite de SchedulerStateReader; los campos omitidos toman su default. */
export type SchedulerSeed = {
  name: string;
  state: TaskState;
  subState?: SubState | null;
  priority?: number;
  prState?: PrState | null;
};

/**
 * Suite de contrato de SchedulerStateReader: corre contra el reader en memoria y contra el de
 * @lunasq/db. `setup` crea las tareas y aristas por nombre (sub-estado null por default) y
 * devuelve el reader y cómo traducir un nombre a su id. readySince lo calcula cada
 * implementación y se prueba aparte.
 */
export function schedulerStateReaderContract(
  name: string,
  setup: (
    tasks: SchedulerSeed[],
    edges: DependencyEdge[],
  ) => { reader: SchedulerStateReader; idOf: (name: string) => string },
): void {
  describe(`contrato de SchedulerStateReader: ${name}`, () => {
    it("devuelve las tareas vivas con su estado, sub-estado, prioridad y PR", () => {
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

    it("incluye las terminales que son dependencia de una viva y omite las demás", () => {
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
      // Solo las aristas de las tareas vivas: las terminales ya no esperan nada.
      expect(snapshot.edges).toHaveLength(2);
      expect(snapshot.edges).toEqual(
        expect.arrayContaining([
          { taskId: idOf("viva"), dependsOnId: idOf("hecha") },
          { taskId: idOf("viva"), dependsOnId: idOf("cancelada") },
        ]),
      );
    });

    it("modificar el snapshot no cambia el siguiente", () => {
      const { reader } = setup(
        [{ name: "a", state: "draft", subState: "queued", priority: 100 }],
        [],
      );
      const first = reader.snapshot();
      const t = first.tasks[0];
      if (!t) throw new Error("sin tareas");
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
