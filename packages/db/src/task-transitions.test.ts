import { TaskTransitionedPayload } from "@lunasq/schemas";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { LunasqDatabase } from "./client.ts";
import { listEvents } from "./event-log.ts";
import { tasks } from "./schema.ts";
import { type TransitionTaskInput, transitionTask } from "./task-transitions.ts";
import { insertProject, insertTask, migratedDatabase } from "./test-helpers.ts";

const taskRow = (db: LunasqDatabase, id: string) => {
  const row = db.select().from(tasks).where(eq(tasks.id, id)).get();
  if (!row) throw new Error("tarea no encontrada");
  return row;
};

const apply = (db: LunasqDatabase, input: TransitionTaskInput) => {
  const result = transitionTask(db, input);
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result;
};

describe("transitionTask", () => {
  it("una transición actualiza la tarea y deja exactamente un evento con actor y payload", () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id);

    const result = apply(db, { taskId: t.id, actor: "system", command: { type: "dispatch" } });

    expect(result.task).toMatchObject({ state: "draft", subState: "running" });
    expect(taskRow(db, t.id)).toMatchObject({ state: "draft", subState: "running" });
    const log = listEvents(db, t.id);
    expect(log).toHaveLength(1);
    expect(log[0]).toEqual(result.event);
    expect(log[0]).toMatchObject({ taskId: t.id, type: "task.transitioned", actor: "system" });
    expect(TaskTransitionedPayload.parse(log[0]?.payload)).toEqual({
      command: "dispatch",
      from: { state: "draft", subState: "queued" },
      to: { state: "draft", subState: "running" },
      verificationIteration: 0,
    });
  });

  it("recorre el ciclo completo con rework: un evento por transición, encadenados", () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id);
    const steps: Omit<TransitionTaskInput, "taskId">[] = [
      { actor: "system", command: { type: "dispatch" } },
      { actor: "agent", command: { type: "submit_spec", specComplete: true } },
      { actor: "human", command: { type: "approve", specApproved: true } },
      { actor: "system", command: { type: "dispatch" } },
      {
        actor: "agent",
        command: {
          type: "submit_for_verification",
          testGatePassed: true,
          everyCriterionHasTest: true,
          hasCommits: true,
        },
      },
      { actor: "system", command: { type: "dispatch" } },
      { actor: "agent", command: { type: "verdict_rework" } },
      { actor: "system", command: { type: "dispatch" } },
      {
        actor: "agent",
        command: {
          type: "submit_for_verification",
          testGatePassed: true,
          everyCriterionHasTest: true,
          hasCommits: true,
        },
      },
      { actor: "system", command: { type: "dispatch" } },
      {
        actor: "system",
        command: {
          type: "verdict_pass",
          verifierPassed: true,
          testGatePassed: true,
          testsCoherent: true,
          allCriteriaPassed: true,
          prCreated: true,
        },
      },
    ];
    for (const step of steps) apply(db, { taskId: t.id, ...step });

    expect(taskRow(db, t.id)).toMatchObject({
      state: "completed",
      subState: null,
      verificationIteration: 1,
    });
    const payloads = listEvents(db, t.id).map((e) => TaskTransitionedPayload.parse(e.payload));
    expect(payloads).toHaveLength(steps.length);
    expect(payloads.map((p) => p.command)).toEqual(steps.map((s) => s.command.type));
    payloads.slice(1).forEach((p, i) => {
      expect(p.from).toEqual(payloads[i]?.to);
    });
  });

  it("una transición rechazada no cambia la tarea ni escribe eventos", () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id);
    apply(db, { taskId: t.id, actor: "system", command: { type: "dispatch" } });
    const before = taskRow(db, t.id);

    const invalid = transitionTask(db, {
      taskId: t.id,
      actor: "human",
      command: { type: "approve", specApproved: true },
    });
    const actor = transitionTask(db, {
      taskId: t.id,
      actor: "human",
      command: { type: "submit_spec", specComplete: true },
    });
    const guard = transitionTask(db, {
      taskId: t.id,
      actor: "agent",
      command: { type: "submit_spec", specComplete: false },
    });

    expect(invalid).toMatchObject({ ok: false, error: { code: "invalid_transition" } });
    expect(actor).toMatchObject({ ok: false, error: { code: "actor_not_allowed" } });
    expect(guard).toMatchObject({ ok: false, error: { code: "guard_failed" } });
    expect(taskRow(db, t.id)).toEqual(before);
    expect(listEvents(db, t.id)).toHaveLength(1);
  });

  it("repetir un comando ya aplicado no duplica el efecto", () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id);
    const dispatch = { taskId: t.id, actor: "system", command: { type: "dispatch" } } as const;
    apply(db, dispatch);
    expect(transitionTask(db, dispatch)).toMatchObject({
      ok: false,
      error: { code: "invalid_transition" },
    });
    expect(listEvents(db, t.id)).toHaveLength(1);
  });

  it("si el evento no se puede escribir, la tarea no cambia", () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id);
    db.$client.exec(
      "create temp trigger fail_events before insert on events begin select raise(abort, 'boom'); end",
    );

    expect(() =>
      transitionTask(db, { taskId: t.id, actor: "system", command: { type: "dispatch" } }),
    ).toThrow(/boom/);
    expect(taskRow(db, t.id)).toMatchObject({ state: "draft", subState: "queued" });
    db.$client.exec("drop trigger fail_events");
    expect(listEvents(db, t.id)).toEqual([]);
  });

  it("rechaza la transición si el estado esperado ya no es el actual", () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id);
    apply(db, { taskId: t.id, actor: "system", command: { type: "dispatch" } });

    const stale = transitionTask(db, {
      taskId: t.id,
      actor: "system",
      command: { type: "escalate", reason: "phase_timeout" },
      expected: { state: "draft", subState: "queued" },
    });

    expect(stale).toMatchObject({ ok: false, error: { code: "stale_state" } });
    expect(taskRow(db, t.id).state).toBe("draft");
    expect(listEvents(db, t.id)).toHaveLength(1);
    expect(
      apply(db, {
        taskId: t.id,
        actor: "system",
        command: { type: "escalate", reason: "phase_timeout" },
        expected: { state: "draft", subState: "running" },
      }).task.state,
    ).toBe("needs_human");
  });

  it("devuelve task_not_found para una tarea inexistente", () => {
    const db = migratedDatabase();
    expect(
      transitionTask(db, { taskId: "nope", actor: "system", command: { type: "dispatch" } }),
    ).toMatchObject({ ok: false, error: { code: "task_not_found" } });
  });

  it("resume vuelve al estado previo al último escalamiento, con la misma iteración", () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id, {
      state: "verification",
      subState: "running",
      verificationIteration: 2,
    });
    apply(db, {
      taskId: t.id,
      actor: "system",
      command: { type: "escalate", reason: "phase_timeout" },
    });
    apply(db, { taskId: t.id, actor: "human", command: { type: "resume" } });
    expect(taskRow(db, t.id)).toMatchObject({
      state: "verification",
      subState: "queued",
      verificationIteration: 2,
    });

    apply(db, { taskId: t.id, actor: "system", command: { type: "dispatch" } });
    apply(db, { taskId: t.id, actor: "agent", command: { type: "verdict_rework" } });
    apply(db, {
      taskId: t.id,
      actor: "system",
      command: { type: "escalate", reason: "hook_failed" },
    });
    const resumed = apply(db, { taskId: t.id, actor: "human", command: { type: "resume" } });
    expect(resumed.task).toMatchObject({ state: "in_progress", subState: "queued" });
  });

  it("resume también vuelve tras escalar por iteraciones agotadas", () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id, {
      state: "verification",
      subState: "running",
      verificationIteration: 3,
    });
    expect(
      apply(db, { taskId: t.id, actor: "agent", command: { type: "verdict_rework" } }).task.state,
    ).toBe("needs_human");
    expect(
      apply(db, { taskId: t.id, actor: "human", command: { type: "resume", resetIteration: true } })
        .task,
    ).toMatchObject({ state: "verification", subState: "queued", verificationIteration: 0 });
    apply(db, { taskId: t.id, actor: "system", command: { type: "dispatch" } });
    expect(
      apply(db, { taskId: t.id, actor: "agent", command: { type: "verdict_rework" } }).task,
    ).toMatchObject({ state: "in_progress", verificationIteration: 1 });
  });

  it("un payload fuera de esquema no llega al log y la tarea sigue reanudable", () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id, { state: "in_progress", subState: "running" });
    expect(
      transitionTask(db, {
        taskId: t.id,
        actor: "system",
        command: { type: "escalate", reason: "blocked", note: "x".repeat(2001) },
      }),
    ).toMatchObject({ ok: false, error: { code: "guard_failed" } });
    expect(listEvents(db, t.id)).toEqual([]);
    apply(db, { taskId: t.id, actor: "system", command: { type: "escalate", reason: "blocked" } });
    expect(
      apply(db, { taskId: t.id, actor: "human", command: { type: "resume" } }).task.state,
    ).toBe("in_progress");
  });

  it("resume sin escalamiento registrado se rechaza", () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id, { state: "needs_human", subState: null });
    expect(
      transitionTask(db, { taskId: t.id, actor: "human", command: { type: "resume" } }),
    ).toMatchObject({ ok: false, error: { code: "no_escalation_found" } });
    expect(listEvents(db, t.id)).toEqual([]);
  });
});
