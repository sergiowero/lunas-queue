import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it } from "vitest";
import { migrateDatabase, migrationsFolder } from "./client.ts";
import {
  events,
  outbox,
  projects,
  questions,
  specs,
  taskDependencies,
  tasks,
  usageRecords,
} from "./schema.ts";
import {
  freshDatabase,
  insertProject,
  insertRun,
  insertTask,
  migratedDatabase,
} from "./test-helpers.ts";

const CHECK = /CHECK constraint failed/;
const UNIQUE = /UNIQUE constraint failed/;
const FK = /FOREIGN KEY constraint failed/;
const NOT_NULL = /NOT NULL constraint failed/;

describe("projects", () => {
  it("genera id, timestamps y defaults de configuración", () => {
    const db = migratedDatabase();
    const p = insertProject(db);
    expect(p.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(p.createdAt).toBeInstanceOf(Date);
    expect(p.agentProfiles).toEqual({});
    expect(p.limits).toEqual({});
  });

  it("name y local_path son únicos", () => {
    const db = migratedDatabase();
    insertProject(db, { name: "lunas", localPath: "/repos/lunas" });
    expect(() => insertProject(db, { name: "lunas" })).toThrow(UNIQUE);
    expect(() => insertProject(db, { localPath: "/repos/lunas" })).toThrow(UNIQUE);
  });

  it("no se puede borrar un proyecto con tareas", () => {
    const db = migratedDatabase();
    const p = insertProject(db);
    insertTask(db, p.id);
    expect(() => db.delete(projects).where(eq(projects.id, p.id)).run()).toThrow(FK);
  });
});

describe("tasks", () => {
  it("la migración del número numera las tareas existentes desde 1 en orden de creación", () => {
    // Base con las migraciones previas a 0007_task_number: las tareas no tienen número.
    const previous = mkdtempSync(join(tmpdir(), "lunasq-drizzle-"));
    try {
      cpSync(migrationsFolder, previous, { recursive: true });
      const journalFile = join(previous, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalFile, "utf8"));
      journal.entries = journal.entries.filter((e: { tag: string }) => e.tag < "0007");
      writeFileSync(journalFile, JSON.stringify(journal));
      const { db } = freshDatabase();
      migrate(db, { migrationsFolder: previous });
      const p = insertProject(db);
      const raw = db.$client.prepare(
        "insert into tasks (id, project_id, intent, priority, created_at, updated_at) values (?, ?, 'x', 1, ?, 0)",
      );
      // Insertadas fuera de orden; dos con el mismo created_at se desempatan por rowid.
      raw.run("c", p.id, 300);
      raw.run("a", p.id, 100);
      raw.run("b1", p.id, 200);
      raw.run("b2", p.id, 200);

      migrateDatabase(db);

      const numbered = db.$client
        .prepare("select id, number from tasks order by number")
        .all() as { id: string; number: number }[];
      expect(numbered).toEqual([
        { id: "a", number: 1 },
        { id: "b1", number: 2 },
        { id: "b2", number: 3 },
        { id: "c", number: 4 },
      ]);
      expect(insertTask(db, p.id).number).toBe(5);
    } finally {
      rmSync(previous, { recursive: true, force: true });
    }
  });

  it("la migración del número no recrea tasks", () => {
    // Recrear la tabla borraría en cascada Runs, aristas y usage.
    const migration = readFileSync(join(migrationsFolder, "0007_task_number.sql"), "utf8");
    expect(migration).not.toMatch(/DROP TABLE/);
  });

  it("número: entero positivo y único, asignado si el insert no lo trae", () => {
    const db = migratedDatabase();
    const p = insertProject(db);
    expect(insertTask(db, p.id).number).toBe(1);
    expect(insertTask(db, p.id, { number: 10 }).number).toBe(10);
    expect(insertTask(db, p.id).number).toBe(11);
    expect(() => insertTask(db, p.id, { number: 10 })).toThrow(UNIQUE);
    expect(() => insertTask(db, p.id, { number: 0 })).toThrow(CHECK);
  });

  it("nace en draft/queued con iteración 0", () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id);
    expect(t.state).toBe("draft");
    expect(t.subState).toBe("queued");
    expect(t.verificationIteration).toBe(0);
    expect(t.tags).toEqual([]);
  });

  it("prioridad es entero sin signo: acepta 0 y enteros grandes", () => {
    const db = migratedDatabase();
    const p = insertProject(db);
    expect(insertTask(db, p.id, { priority: 0 }).priority).toBe(0);
    expect(insertTask(db, p.id, { priority: 2 ** 31 }).priority).toBe(2 ** 31);
  });

  it("prioridad no pasa de Number.MAX_SAFE_INTEGER", () => {
    const db = migratedDatabase();
    const p = insertProject(db);
    expect(insertTask(db, p.id, { priority: Number.MAX_SAFE_INTEGER }).priority).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(() =>
      db.$client
        .prepare(
          "insert into tasks (id, project_id, intent, priority) values ('big', ?, 'x', 9007199254740992)",
        )
        .run(p.id),
    ).toThrow(CHECK);
  });

  it("prioridad rechaza negativos, no enteros y NULL", () => {
    const db = migratedDatabase();
    const p = insertProject(db);
    expect(() => insertTask(db, p.id, { priority: -1 })).toThrow(CHECK);
    expect(() => insertTask(db, p.id, { priority: 1.5 })).toThrow(CHECK);
    const raw = db.$client.prepare(
      "insert into tasks (id, project_id, intent, priority, created_at, updated_at) values (?, ?, 'x', ?, 0, 0)",
    );
    expect(() => raw.run("t-text", p.id, "cien")).toThrow(CHECK);
    expect(() => raw.run("t-null", p.id, null)).toThrow(NOT_NULL);
  });

  it("estado, sub-estado, PR y riesgo solo aceptan valores del enum", () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id);
    const set = (col: string, value: string) =>
      db.$client.prepare(`update tasks set ${col} = ? where id = ?`).run(value, t.id);
    expect(() => set("state", "new")).toThrow(CHECK);
    expect(() => set("sub_state", "sleeping")).toThrow(CHECK);
    expect(() => set("pr_state", "draft")).toThrow(CHECK);
    expect(() => set("risk_label", "critical")).toThrow(CHECK);
    expect(() => set("state", "in_progress")).not.toThrow();
  });

  it("iteración de verificación no puede ser negativa", () => {
    const db = migratedDatabase();
    const p = insertProject(db);
    expect(() => insertTask(db, p.id, { verificationIteration: -1 })).toThrow(CHECK);
  });

  it("project_id debe existir", () => {
    const db = migratedDatabase();
    expect(() => insertTask(db, "no-existe")).toThrow(FK);
  });

  it("caused_by apunta a otra tarea y queda en NULL si esa se borra", () => {
    const db = migratedDatabase();
    const p = insertProject(db);
    const origin = insertTask(db, p.id);
    const fix = insertTask(db, p.id, { causedBy: origin.id });
    expect(() => insertTask(db, p.id, { causedBy: "no-existe" })).toThrow(FK);
    db.delete(tasks).where(eq(tasks.id, origin.id)).run();
    expect(db.select().from(tasks).where(eq(tasks.id, fix.id)).get()?.causedBy).toBeNull();
  });
});

describe("task_dependencies", () => {
  it("la arista es única y no admite self-loop", () => {
    const db = migratedDatabase();
    const p = insertProject(db);
    const a = insertTask(db, p.id);
    const b = insertTask(db, p.id);
    db.insert(taskDependencies).values({ taskId: a.id, dependsOnId: b.id }).run();
    expect(() =>
      db.insert(taskDependencies).values({ taskId: a.id, dependsOnId: b.id }).run(),
    ).toThrow(UNIQUE);
    expect(() =>
      db.insert(taskDependencies).values({ taskId: a.id, dependsOnId: a.id }).run(),
    ).toThrow(CHECK);
  });

  it("ambos extremos deben existir y la arista se borra con cualquiera de ellos", () => {
    const db = migratedDatabase();
    const p = insertProject(db);
    const a = insertTask(db, p.id);
    const b = insertTask(db, p.id);
    const c = insertTask(db, p.id);
    expect(() =>
      db.insert(taskDependencies).values({ taskId: a.id, dependsOnId: "x" }).run(),
    ).toThrow(FK);
    db.insert(taskDependencies)
      .values([
        { taskId: a.id, dependsOnId: b.id },
        { taskId: c.id, dependsOnId: a.id },
      ])
      .run();
    db.delete(tasks).where(eq(tasks.id, a.id)).run();
    expect(db.select().from(taskDependencies).all()).toEqual([]);
  });
});

describe("specs", () => {
  const criterion = {
    id: "AC-1",
    given: "dos tareas que dependen entre sí",
    when: "se agrega la arista que cierra el ciclo",
    outcome: "la arista se rechaza",
  };

  it("versión única por tarea, iniciando en pending", () => {
    const db = migratedDatabase();
    const p = insertProject(db);
    const t = insertTask(db, p.id);
    const other = insertTask(db, p.id);
    const [v1] = db
      .insert(specs)
      .values({
        taskId: t.id,
        version: 1,
        acceptanceCriteria: [criterion],
      })
      .returning()
      .all();
    expect(v1?.approval).toBe("pending");
    expect(v1?.createdBy).toBe("agent");
    expect(v1?.acceptanceCriteria).toEqual([criterion]);
    db.insert(specs).values({ taskId: t.id, version: 2 }).run();
    db.insert(specs).values({ taskId: other.id, version: 1 }).run();
    expect(() => db.insert(specs).values({ taskId: t.id, version: 1 }).run()).toThrow(UNIQUE);
  });

  it("una sola versión aprobada por tarea", () => {
    const db = migratedDatabase();
    const p = insertProject(db);
    const t = insertTask(db, p.id);
    const other = insertTask(db, p.id);
    db.insert(specs).values({ taskId: t.id, version: 1, approval: "approved" }).run();
    db.insert(specs).values({ taskId: t.id, version: 2, approval: "changes_requested" }).run();
    db.insert(specs).values({ taskId: other.id, version: 1, approval: "approved" }).run();
    expect(() =>
      db.insert(specs).values({ taskId: t.id, version: 3, approval: "approved" }).run(),
    ).toThrow(UNIQUE);
  });

  it("autor del enum de actores", () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id);
    expect(() =>
      db.$client
        .prepare(
          "insert into specs (id, task_id, version, created_by, created_at) values ('s', ?, 1, 'robot', 0)",
        )
        .run(t.id),
    ).toThrow(CHECK);
  });

  it("versión positiva y aprobación del enum", () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id);
    expect(() => db.insert(specs).values({ taskId: t.id, version: 0 }).run()).toThrow(CHECK);
    expect(() =>
      db.$client
        .prepare(
          "insert into specs (id, task_id, version, approval, created_at) values ('s', ?, 1, 'maybe', 0)",
        )
        .run(t.id),
    ).toThrow(CHECK);
  });
});

describe("runs", () => {
  it("guarda modelo e iteración, con iteración 0 por defecto y no negativa", () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id);
    const r = insertRun(db, t.id, { model: "claude-opus-5-5" });
    expect(r.model).toBe("claude-opus-5-5");
    expect(r.iteration).toBe(0);
    expect(() => insertRun(db, t.id, { iteration: -1 })).toThrow(CHECK);
    expect(() => insertRun(db, t.id, { iteration: 0.5 })).toThrow(CHECK);
  });

  it("una tarea tiene a lo sumo un Run activo (sin ended_at)", () => {
    const db = migratedDatabase();
    const p = insertProject(db);
    const t = insertTask(db, p.id);
    const first = insertRun(db, t.id);
    expect(() => insertRun(db, t.id)).toThrow(UNIQUE);
    insertRun(db, insertTask(db, p.id).id);
    db.$client
      .prepare("update runs set ended_at = 1, result = 'failure' where id = ?")
      .run(first.id);
    expect(() => insertRun(db, t.id)).not.toThrow();
  });

  it("run_token es único", () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id);
    insertRun(db, t.id, { runToken: "abc" });
    expect(() => insertRun(db, t.id, { runToken: "abc" })).toThrow(UNIQUE);
  });

  it("fase, tipo de agente y resultado solo aceptan valores del enum", () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id);
    const r = insertRun(db, t.id);
    const set = (col: string, value: string) =>
      db.$client.prepare(`update runs set ${col} = ? where id = ?`).run(value, r.id);
    expect(() => set("phase", "deploy")).toThrow(CHECK);
    expect(() => set("agent_kind", "codex")).toThrow(CHECK);
    expect(() => set("result", "ok")).toThrow(CHECK);
    expect(() => set("result", "failure")).not.toThrow();
    expect(() => set("agent_session_source", "otra")).toThrow(CHECK);
    expect(() => set("agent_session_source", "native")).not.toThrow();
  });

  it("la migración del dispatcher conserva los Runs y su usage", () => {
    // Las columnas nuevas entran con ADD COLUMN: recrear `runs` borraría usage en cascada.
    const db = migratedDatabase();
    const r = insertRun(db, insertTask(db, insertProject(db).id).id);
    expect(r.agentSessionSource).toBeNull();
    expect(r.launchedAt).toBeNull();
    const migration = readFileSync(join(migrationsFolder, "0004_dispatcher.sql"), "utf8");
    expect(migration).not.toMatch(/DROP TABLE/);
  });

  it("guarda handoff como JSON y requiere una tarea existente", () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id);
    const r = insertRun(db, t.id, { handoff: { summary: "listo", tests: ["a.test.ts"] } });
    expect(r.handoff).toEqual({ summary: "listo", tests: ["a.test.ts"] });
    expect(() => insertRun(db, "no-existe")).toThrow(FK);
  });
});

describe("questions", () => {
  it("nace abierta, run_id queda en NULL si se borra el Run", () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id);
    const r = insertRun(db, t.id);
    const [q] = db
      .insert(questions)
      .values({ taskId: t.id, runId: r.id, question: "¿Postgres o SQLite?" })
      .returning()
      .all();
    expect(q?.status).toBe("open");
    db.$client.prepare("delete from runs where id = ?").run(r.id);
    expect(db.select().from(questions).get()?.runId).toBeNull();
  });

  it("estado del enum y llaves existentes", () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id);
    expect(() => db.insert(questions).values({ taskId: "x", question: "?" }).run()).toThrow(FK);
    expect(() =>
      db.insert(questions).values({ taskId: t.id, runId: "x", question: "?" }).run(),
    ).toThrow(FK);
    expect(() =>
      db.$client
        .prepare(
          "insert into questions (id, task_id, question, status, created_at) values ('q', ?, '?', 'pending', 0)",
        )
        .run(t.id),
    ).toThrow(CHECK);
  });
});

describe("usage_records", () => {
  it("pertenece a un Run, con tokens no negativos y fuente del enum", () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id);
    const r = insertRun(db, t.id);
    const base = { runId: r.id, model: "claude-opus-5-5", source: "otel" as const };
    const [u] = db
      .insert(usageRecords)
      .values({ ...base, inputTokens: 10, outputTokens: 5, costUsd: 0.12 })
      .returning()
      .all();
    expect(u?.cacheReadTokens).toBe(0);
    expect(() =>
      db
        .insert(usageRecords)
        .values({ ...base, runId: "x" })
        .run(),
    ).toThrow(FK);
    expect(() =>
      db
        .insert(usageRecords)
        .values({ ...base, outputTokens: -1 })
        .run(),
    ).toThrow(CHECK);
    expect(() =>
      db
        .insert(usageRecords)
        .values({ ...base, costUsd: -0.01 })
        .run(),
    ).toThrow(CHECK);
    expect(() =>
      db
        .insert(usageRecords)
        .values({ ...base, inputTokens: 1.5 })
        .run(),
    ).toThrow(CHECK);
    expect(() =>
      db.$client
        .prepare(
          "insert into usage_records (id, run_id, model, source, created_at) values ('u', ?, 'm', 'guess', 0)",
        )
        .run(r.id),
    ).toThrow(CHECK);
  });
});

describe("usage_records: deduplicación", () => {
  it("source_ref es único por Run y fuente; sin source_ref no se deduplica", () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id);
    const r = insertRun(db, t.id);
    const base = { runId: r.id, model: "m", source: "otel" as const };
    db.insert(usageRecords)
      .values({ ...base, sourceRef: "msg-1" })
      .run();
    expect(() =>
      db
        .insert(usageRecords)
        .values({ ...base, sourceRef: "msg-1" })
        .run(),
    ).toThrow(UNIQUE);
    db.insert(usageRecords)
      .values({ ...base, source: "transcript", sourceRef: "msg-1" })
      .run();
    db.insert(usageRecords).values(base).run();
    db.insert(usageRecords).values(base).run();
    expect(db.select().from(usageRecords).all()).toHaveLength(4);
  });
});

describe("events y outbox", () => {
  it("eventos con id creciente, actor del enum y payload JSON", () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id);
    const [e1] = db
      .insert(events)
      .values({ taskId: t.id, type: "task.created", actor: "human", payload: { intent: "x" } })
      .returning()
      .all();
    const [e2] = db
      .insert(events)
      .values({ taskId: t.id, type: "task.refined", actor: "agent" })
      .returning()
      .all();
    expect(e1?.payload).toEqual({ intent: "x" });
    expect(e2?.id).toBeGreaterThan(e1?.id ?? Number.POSITIVE_INFINITY);
    expect(() =>
      db.insert(events).values({ taskId: "x", type: "t", actor: "system" }).run(),
    ).toThrow(FK);
    expect(() =>
      db.$client
        .prepare(
          "insert into events (task_id, type, actor, created_at) values (?, 't', 'robot', 0)",
        )
        .run(t.id),
    ).toThrow(CHECK);
  });

  it("un solo mensaje de outbox por evento, pendiente hasta publicarse", () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id);
    const [e] = db
      .insert(events)
      .values({ taskId: t.id, type: "task.created", actor: "human" })
      .returning()
      .all();
    if (!e) throw new Error("sin evento");
    const [m] = db
      .insert(outbox)
      .values({ eventId: e.id, topic: "task.state_changed" })
      .returning()
      .all();
    expect(m?.publishedAt).toBeNull();
    expect(m?.attempts).toBe(0);
    expect(() => db.insert(outbox).values({ eventId: e.id, topic: "otro" }).run()).toThrow(UNIQUE);
    expect(() => db.insert(outbox).values({ eventId: 9999, topic: "x" }).run()).toThrow(FK);
  });
});

describe("borrado de una tarea", () => {
  it("arrastra specs, runs, questions, usage y aristas cuando no tiene eventos", () => {
    const db = migratedDatabase();
    const p = insertProject(db);
    const t = insertTask(db, p.id);
    const other = insertTask(db, p.id);
    const r = insertRun(db, t.id);
    db.insert(specs).values({ taskId: t.id, version: 1 }).run();
    db.insert(questions).values({ taskId: t.id, runId: r.id, question: "?" }).run();
    db.insert(usageRecords).values({ runId: r.id, model: "m", source: "otel" }).run();
    db.insert(taskDependencies).values({ taskId: other.id, dependsOnId: t.id }).run();

    db.delete(tasks).where(eq(tasks.id, t.id)).run();

    for (const table of [specs, questions, usageRecords, taskDependencies]) {
      expect(db.select().from(table).all()).toEqual([]);
    }
    expect(db.$client.prepare("select count(*) from runs").pluck().get()).toBe(0);
  });

  it("el Event log es append-only: una tarea con eventos no se puede borrar", () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id);
    db.insert(events).values({ taskId: t.id, type: "task.created", actor: "human" }).run();
    expect(() => db.delete(tasks).where(eq(tasks.id, t.id)).run()).toThrow(FK);
    expect(db.select().from(events).all()).toHaveLength(1);
  });
});
