import type { Project, SchedulablePhase, SchedulerConfigInput } from "@lunasq/schemas";
import { SchedulerConfig } from "@lunasq/schemas";
import { describe, expect, it } from "vitest";
import type { DependencyEdge } from "./dependency-graph.ts";
import { InMemoryProjectConfigReader } from "./project-config.ts";
import {
  InMemorySchedulerStateReader,
  Occupancy,
  pendingPhase,
  rankReady,
  type SchedulerSnapshot,
  type SchedulerTask,
  schedule,
} from "./scheduler.ts";
import { sampleProject, schedulerStateReaderContract } from "./testing.ts";

const NOW = new Date("2026-10-29T12:00:00Z");
const HOUR = 3_600_000;
const ago = (hours: number) => new Date(NOW.getTime() - hours * HOUR);

const alfa = sampleProject("alfa");
const beta = sampleProject("beta");

let order = 0;
/** Tarea en draft/queued, lista desde ahora; cada una un poco más nueva que la anterior. */
function task(id: string, overrides: Partial<SchedulerTask> = {}): SchedulerTask {
  order += 1;
  return {
    id,
    projectId: alfa.id,
    state: "draft",
    subState: "queued",
    priority: 100,
    prState: null,
    createdAt: new Date(ago(48).getTime() + order),
    readySince: NOW,
    ...overrides,
  };
}

const merged = (id: string, overrides: Partial<SchedulerTask> = {}) =>
  task(id, { state: "completed", subState: null, prState: "merged", ...overrides });

const edge = (taskId: string, dependsOnId: string): DependencyEdge => ({ taskId, dependsOnId });

// Sin aging ni boost salvo que el test los pida: aísla la regla que se prueba.
const config = (input: SchedulerConfigInput = {}) =>
  SchedulerConfig.parse({ agingPointsPerHour: 0, boostPerDescendant: 0, ...input });

function plan(
  tasks: SchedulerTask[],
  edges: DependencyEdge[] = [],
  input: SchedulerConfigInput = {},
  projects: Project[] = [alfa, beta],
) {
  const snapshot: SchedulerSnapshot = { tasks, edges };
  return schedule(snapshot, new InMemoryProjectConfigReader(projects), config(input), NOW);
}

const dispatched = (result: ReturnType<typeof plan>) => result.dispatch.map((d) => d.taskId);

describe("pendingPhase", () => {
  it("draft refina, in_progress implementa y verification verifica", () => {
    expect(pendingPhase("draft")).toBe("refine");
    expect(pendingPhase("in_progress")).toBe("implement");
    expect(pendingPhase("verification")).toBe("verify");
  });

  it.each(["refined", "needs_human", "completed", "cancelled"] as const)(
    "%s no lleva agente",
    (state) => {
      expect(pendingPhase(state)).toBeNull();
    },
  );
});

describe("ready set", () => {
  it("solo entran las tareas queued de un estado con agente", () => {
    const result = plan([
      task("draft"),
      task("impl", { state: "in_progress" }),
      task("verif", { state: "verification" }),
      task("corriendo", { subState: "running" }),
      task("pregunta", { state: "in_progress", subState: "waiting_human" }),
      task("gate", { state: "refined", subState: null }),
      task("humano", { state: "needs_human", subState: null }),
    ]);
    expect(dispatched(result).sort()).toEqual(["draft", "impl", "verif"]);
    expect(result.dispatch.find((d) => d.taskId === "impl")).toMatchObject({
      phase: "implement",
      agentKind: "claude",
      projectId: alfa.id,
      expected: { state: "in_progress", subState: "queued" },
    });
  });

  it("una tarea espera hasta que todas sus dependencias tengan el PR mergeado", () => {
    const result = plan(
      [
        task("a", { state: "completed", subState: null, prState: "open" }),
        merged("b"),
        task("c"),
        task("d"),
      ],
      [edge("c", "a"), edge("c", "b"), edge("d", "b")],
    );
    expect(dispatched(result)).toEqual(["d"]);
  });

  it("una dependencia completed sin PR o en curso no satisface", () => {
    const result = plan(
      [
        task("sin-pr", { state: "completed", subState: null }),
        task("en-curso", { state: "in_progress", subState: "running" }),
        task("x"),
        task("y"),
      ],
      [edge("x", "sin-pr"), edge("y", "en-curso")],
    );
    expect(dispatched(result)).toEqual([]);
  });

  it("una dependencia ausente del snapshot no satisface", () => {
    expect(dispatched(plan([task("x")], [edge("x", "fantasma")]))).toEqual([]);
  });

  it("en una cadena solo avanza el primer eslabón", () => {
    const result = plan([task("a"), task("b"), task("c")], [edge("b", "a"), edge("c", "b")]);
    expect(dispatched(result)).toEqual(["a"]);
  });

  it("en un diamante la de abajo espera a las dos ramas", () => {
    const tasks = [merged("raiz"), merged("izq"), task("der"), task("abajo")];
    const edges = [
      edge("izq", "raiz"),
      edge("der", "raiz"),
      edge("abajo", "izq"),
      edge("abajo", "der"),
    ];
    expect(dispatched(plan(tasks, edges))).toEqual(["der"]);
    const listo = tasks.map((t) => (t.id === "der" ? merged("der") : t));
    expect(dispatched(plan(listo, edges))).toEqual(["abajo"]);
  });
});

describe("orden por score", () => {
  it("mayor prioridad primero y los empates por antigüedad", () => {
    const result = plan([
      task("vieja-100"),
      task("p300", { priority: 300 }),
      task("nueva-100"),
      task("p200", { priority: 200 }),
    ]);
    expect(dispatched(result)).toEqual(["p300", "p200", "vieja-100", "nueva-100"]);
  });

  it("con la misma antigüedad desempata por id", () => {
    const createdAt = ago(1);
    const result = plan([task("b", { createdAt }), task("a", { createdAt })]);
    expect(dispatched(result)).toEqual(["a", "b"]);
  });

  it("el aging deja que una tarea vieja de baja prioridad rebase a una nueva", () => {
    const tasks = [
      task("nueva-alta", { priority: 200, readySince: NOW }),
      task("vieja-baja", { priority: 100, readySince: ago(11) }),
    ];
    expect(dispatched(plan(tasks, [], { agingPointsPerHour: 10 }))).toEqual([
      "vieja-baja",
      "nueva-alta",
    ]);
    expect(dispatched(plan(tasks, [], { agingPointsPerHour: 0 }))).toEqual([
      "nueva-alta",
      "vieja-baja",
    ]);
  });

  it("el aging no resta si readySince está en el futuro", () => {
    const ranked = rankReady(
      { tasks: [task("x", { readySince: new Date(NOW.getTime() + HOUR) })], edges: [] },
      config({ agingPointsPerHour: 10 }),
      NOW,
    );
    expect(ranked[0]?.score).toBe(100);
  });

  it("el boost sube a la que bloquea más tareas no terminales", () => {
    const tasks = [
      task("bloquea-1", { priority: 100 }),
      task("bloquea-3", { priority: 100 }),
      task("d1", { priority: 0 }),
      task("d2", { priority: 0 }),
      task("d3", { priority: 0 }),
      task("d4", { priority: 0 }),
      task("hecha", { priority: 0, state: "cancelled", subState: null }),
    ];
    const edges = [
      edge("d1", "bloquea-1"),
      edge("d2", "bloquea-3"),
      edge("d3", "d2"),
      edge("d4", "d2"),
      edge("hecha", "bloquea-1"),
      edge("hecha", "bloquea-3"),
    ];
    const ranked = rankReady({ tasks, edges }, config({ boostPerDescendant: 25 }), NOW);
    expect(ranked.map((r) => [r.task.id, r.score])).toEqual([
      ["bloquea-3", 175],
      ["bloquea-1", 125],
    ]);
  });

  it("hereda la prioridad de la tarea que bloquea, directa o transitivamente", () => {
    const tasks = [
      task("base-100", { priority: 100 }),
      task("medio", { priority: 50 }),
      task("urgente", { priority: 900 }),
      task("otra", { priority: 500 }),
    ];
    const edges = [edge("medio", "base-100"), edge("urgente", "medio")];
    const ranked = rankReady({ tasks, edges }, config(), NOW);
    expect(ranked.map((r) => [r.task.id, r.effectivePriority])).toEqual([
      ["base-100", 900],
      ["otra", 500],
    ]);
    // La prioridad capturada no cambia.
    expect(ranked[0]?.task.priority).toBe(100);
  });

  it("la herencia termina cuando la tarea bloqueada deja de estar viva", () => {
    const tasks = [
      task("base-100", { priority: 100 }),
      task("urgente", { priority: 900, state: "cancelled", subState: null }),
      task("otra", { priority: 500 }),
    ];
    const ranked = rankReady({ tasks, edges: [edge("urgente", "base-100")] }, config(), NOW);
    expect(ranked.map((r) => [r.task.id, r.effectivePriority])).toEqual([
      ["otra", 500],
      ["base-100", 100],
    ]);
  });
});

describe("límites de concurrencia", () => {
  const many = (n: number, overrides: Partial<SchedulerTask> = {}) =>
    Array.from({ length: n }, (_, i) => task(`t${i}`, overrides));

  it("el límite global es 5 por default", () => {
    expect(plan(many(8)).dispatch).toHaveLength(5);
  });

  it("los agentes vivos ocupan slots, también los que esperan al humano", () => {
    const vivos = [
      task("r1", { subState: "running" }),
      task("r2", { state: "in_progress", subState: "running" }),
      task("w1", { state: "verification", subState: "waiting_human" }),
    ];
    expect(plan([...vivos, ...many(5)]).dispatch).toHaveLength(2);
  });

  it("los gates humanos y las tareas en needs_human no ocupan slots", () => {
    const sinAgente = [
      task("gate", { state: "refined", subState: null }),
      task("humano", { state: "needs_human", subState: null }),
    ];
    expect(plan([...sinAgente, ...many(5)]).dispatch).toHaveLength(5);
  });

  it("con todos los slots ocupados no despacha nada y no hay preemption", () => {
    const vivos = many(5, { subState: "running", priority: 1 });
    const result = plan([...vivos, task("urgente", { priority: 1000 })]);
    expect(result.dispatch).toEqual([]);
  });

  it("respeta el límite por proyecto y deja pasar a otros proyectos", () => {
    const limitado = sampleProject("limitado", { limits: { concurrency: 1 } });
    const tasks = [
      task("l-vivo", { projectId: limitado.id, subState: "running" }),
      task("l1", { projectId: limitado.id, priority: 900 }),
      task("l2", { projectId: limitado.id, priority: 800 }),
      task("b1", { projectId: beta.id }),
    ];
    expect(dispatched(plan(tasks, [], {}, [limitado, beta]))).toEqual(["b1"]);
  });

  it("el límite por proyecto cuenta todas las fases", () => {
    const limitado = sampleProject("limitado", { limits: { concurrency: 2 } });
    const tasks = [
      task("refina", { projectId: limitado.id, priority: 300 }),
      task("implementa", { projectId: limitado.id, state: "in_progress", priority: 200 }),
      task("verifica", { projectId: limitado.id, state: "verification", priority: 100 }),
    ];
    expect(dispatched(plan(tasks, [], {}, [limitado]))).toEqual(["refina", "implementa"]);
  });

  it("respeta el límite por fase", () => {
    const tasks = [
      task("r1", { priority: 900 }),
      task("r2", { priority: 800 }),
      task("i1", { state: "in_progress", priority: 100 }),
      task("i-vivo", { state: "in_progress", subState: "running" }),
      task("i2", { state: "in_progress", priority: 50 }),
    ];
    const result = plan(tasks, [], { phaseConcurrency: { refine: 1, implement: 2 } });
    expect(dispatched(result)).toEqual(["r1", "i1"]);
  });

  it("respeta el límite por tipo de agente", () => {
    const tasks = [task("vivo", { subState: "running" }), ...many(4)];
    expect(plan(tasks, [], { agentKindConcurrency: { claude: 3 } }).dispatch).toHaveLength(2);
  });

  it("un límite agotado salta a la siguiente tarea que sí cabe", () => {
    const tasks = [
      task("r-alta", { priority: 900 }),
      task("r-media", { priority: 800 }),
      task("i-baja", { state: "in_progress", priority: 10 }),
    ];
    const result = plan(tasks, [], { phaseConcurrency: { refine: 1 } });
    expect(dispatched(result)).toEqual(["r-alta", "i-baja"]);
  });

  it("no despacha tareas de un proyecto sin configuración", () => {
    expect(plan([task("x")], [], {}, [beta]).dispatch).toEqual([]);
  });
});

describe("Occupancy", () => {
  const reader = new InMemoryProjectConfigReader([alfa]);

  it("revalida una decisión contra un snapshot más nuevo", () => {
    const decision = plan([task("x")], [], { globalConcurrency: 1 }).dispatch[0];
    if (!decision) throw new Error("sin decisión");
    const occupancy = (tasks: SchedulerTask[]) => Occupancy.of({ tasks, edges: [] }, reader);
    const slot = occupancy([]).slotFor(decision, decision.phase);
    expect(occupancy([]).fits(slot, config({ globalConcurrency: 1 }))).toBe(true);
    // Otro proceso despachó en medio: el claim ya no cabe.
    const otro = [task("otro", { subState: "running" })];
    expect(occupancy(otro).fits(slot, config({ globalConcurrency: 1 }))).toBe(false);
  });

  it("sin configuración del proyecto no cabe", () => {
    const occupancy = Occupancy.of({ tasks: [], edges: [] }, reader);
    const slot = occupancy.slotFor({ projectId: beta.id }, "refine");
    expect(slot.agentKind).toBeUndefined();
    expect(occupancy.fits(slot, config())).toBe(false);
  });
});

describe("dependencias que ya no se entregarán", () => {
  it("escala a los dependientes de una dependencia con PR cerrado o cancelada", () => {
    const result = plan(
      [
        task("cerrada", { state: "completed", subState: null, prState: "closed" }),
        task("cancelada", { state: "cancelled", subState: null }),
        task("x"),
        task("y"),
        task("z"),
      ],
      [edge("x", "cerrada"), edge("y", "cancelada"), edge("z", "y")],
    );
    expect(result.escalate).toEqual([
      { taskId: "x", dependsOnId: "cerrada", expected: { state: "draft", subState: "queued" } },
      { taskId: "y", dependsOnId: "cancelada", expected: { state: "draft", subState: "queued" } },
    ]);
    expect(result.dispatch).toEqual([]);
  });

  it("una cancelada con el PR ya mergeado sigue satisfaciendo", () => {
    const result = plan(
      [task("dep", { state: "cancelled", subState: null, prState: "merged" }), task("x")],
      [edge("x", "dep")],
    );
    expect(result.escalate).toEqual([]);
    expect(dispatched(result)).toEqual(["x"]);
  });

  it("no escala a dependientes terminales ni a los que ya están en needs_human", () => {
    const result = plan(
      [
        task("cancelada", { state: "cancelled", subState: null }),
        task("humano", { state: "needs_human", subState: null }),
        task("fin", { state: "cancelled", subState: null }),
      ],
      [edge("humano", "cancelada"), edge("fin", "cancelada")],
    );
    expect(result.escalate).toEqual([]);
  });

  it("no escala a un dependiente con su agente vivo: liberaría el slot con el agente corriendo", () => {
    const result = plan(
      [
        task("cerrada", { state: "completed", subState: null, prState: "closed" }),
        task("refinando", { subState: "running" }),
        task("preguntando", { subState: "waiting_human" }),
      ],
      [edge("refinando", "cerrada"), edge("preguntando", "cerrada")],
    );
    expect(result.escalate).toEqual([]);
  });

  it("escala una vez aunque falle más de una dependencia", () => {
    const result = plan(
      [
        task("c1", { state: "cancelled", subState: null }),
        task("c2", { state: "cancelled", subState: null }),
        task("x"),
      ],
      [edge("x", "c1"), edge("x", "c2")],
    );
    expect(result.escalate.map((e) => e.taskId)).toEqual(["x"]);
  });
});

describe("nunca se exceden los límites (DAGs aleatorios)", () => {
  // mulberry32: determinístico para que un fallo se pueda reproducir con la semilla.
  function rng(seed: number) {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const STATES = ["draft", "in_progress", "verification", "refined", "completed"] as const;

  it.each(Array.from({ length: 40 }, (_, i) => i + 1))("semilla %i", (seed) => {
    const random = rng(seed);
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(random() * xs.length)] as T;
    const projects = [
      sampleProject(`p${seed}-a`, { limits: { concurrency: 1 + Math.floor(random() * 3) } }),
      sampleProject(`p${seed}-b`),
      sampleProject(`p${seed}-c`, { limits: { concurrency: 2 } }),
    ];
    const input: SchedulerConfigInput = {
      globalConcurrency: 1 + Math.floor(random() * 6),
      phaseConcurrency: random() < 0.5 ? { refine: 1 + Math.floor(random() * 3) } : {},
      agentKindConcurrency: random() < 0.3 ? { claude: 1 + Math.floor(random() * 4) } : {},
      agingPointsPerHour: random() * 20,
      boostPerDescendant: random() * 50,
    };
    const parsed = config(input);
    let tasks = Array.from({ length: 30 }, (_, i) => {
      const state = pick(STATES);
      const live = state === "draft" || state === "in_progress" || state === "verification";
      return task(`t${i}`, {
        projectId: pick(projects).id,
        state,
        subState: live
          ? pick(["running", "waiting_human", "queued", "queued", "queued"] as const)
          : null,
        priority: Math.floor(random() * 1000),
        prState: state === "completed" ? pick(["merged", "open"] as const) : null,
        readySince: ago(random() * 48),
      });
    });
    // Aristas solo hacia tareas anteriores: acíclico por construcción.
    const edges: DependencyEdge[] = [];
    for (let i = 1; i < tasks.length; i++) {
      for (let j = 0; j < i; j++) if (random() < 0.06) edges.push(edge(`t${i}`, `t${j}`));
    }

    const live = () =>
      tasks.filter((t) => t.subState === "running" || t.subState === "waiting_human");
    const reader = new InMemoryProjectConfigReader(projects);
    for (let pass = 0; pass < 6; pass++) {
      const before = live().length;
      const result = schedule({ tasks, edges }, reader, parsed, NOW);
      const chosen = new Set(result.dispatch.map((d) => d.taskId));
      tasks = tasks.map((t) => (chosen.has(t.id) ? { ...t, subState: "running" } : t));
      const running = live();
      const count = (pred: (t: SchedulerTask) => boolean) => running.filter(pred).length;
      // Solo se exige el tope si esta pasada agregó algo: los vivos iniciales son aleatorios.
      if (chosen.size > 0) {
        expect(running.length).toBeLessThanOrEqual(parsed.globalConcurrency);
        expect(before + chosen.size).toBe(running.length);
      }
      for (const d of result.dispatch) {
        const project = projects.find((p) => p.id === d.projectId);
        const limit = project?.limits.concurrency;
        if (limit) expect(count((t) => t.projectId === d.projectId)).toBeLessThanOrEqual(limit);
        const phaseLimit = parsed.phaseConcurrency[d.phase];
        if (phaseLimit) {
          expect(count((t) => pendingPhase(t.state) === d.phase)).toBeLessThanOrEqual(phaseLimit);
        }
        const kindLimit = parsed.agentKindConcurrency.claude;
        if (kindLimit) expect(running.length).toBeLessThanOrEqual(kindLimit);
        // Toda tarea despachada tiene sus dependencias mergeadas.
        for (const dep of edges.filter((e) => e.taskId === d.taskId)) {
          expect(tasks.find((t) => t.id === dep.dependsOnId)?.prState).toBe("merged");
        }
      }
      // Y no deja slots libres sin usar: toda tarea lista que quedó fuera ya no cabe.
      const after = Occupancy.of({ tasks, edges }, reader);
      for (const { task: waiting } of rankReady({ tasks, edges }, parsed, NOW)) {
        const slot = after.slotFor(waiting, pendingPhase(waiting.state) as SchedulablePhase);
        expect(after.fits(slot, parsed)).toBe(false);
      }
      // Algunos agentes terminan entre pasadas.
      tasks = tasks.map((t) =>
        t.subState === "running" && random() < 0.4
          ? { ...t, state: "completed", subState: null, prState: "merged" }
          : t,
      );
    }
  });
});

schedulerStateReaderContract("en memoria", (seeds, edges) => {
  const project = sampleProject("contrato");
  const tasks = seeds.map((seed) =>
    task(seed.name, {
      projectId: project.id,
      state: seed.state,
      subState: seed.subState ?? null,
      priority: seed.priority ?? 100,
      prState: seed.prState ?? null,
    }),
  );
  return { reader: new InMemorySchedulerStateReader(tasks, edges), idOf: (name) => name };
});
