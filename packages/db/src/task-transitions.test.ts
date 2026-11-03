import { DEFAULT_MAX_ITERATIONS } from "@lunasq/domain";
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
  if (!row) throw new Error("task not found");
  return row;
};

const apply = (db: LunasqDatabase, input: TransitionTaskInput) => {
  const result = transitionTask(db, input);
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result;
};

describe("transitionTask", () => {
  it("a transition updates the task and leaves exactly one event with actor and payload", () => {
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

  it("goes through the full cycle with rework: one event per transition, chained", () => {
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

  it("a rejected transition changes neither the task nor writes events", () => {
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

  it("repeating an already applied command does not duplicate the effect", () => {
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

  it("if the event cannot be written, the task does not change", () => {
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

  it("rejects the transition if the expected state is no longer the current one", () => {
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

  it("returns task_not_found for a nonexistent task", () => {
    const db = migratedDatabase();
    expect(
      transitionTask(db, { taskId: "nope", actor: "system", command: { type: "dispatch" } }),
    ).toMatchObject({ ok: false, error: { code: "task_not_found" } });
  });

  it("resume goes back to the state prior to the last escalation, with the same iteration", () => {
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

  it("resume also goes back after escalating due to exhausted iterations", () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id, {
      state: "verification",
      subState: "running",
      verificationIteration: DEFAULT_MAX_ITERATIONS,
    });
    expect(
      apply(db, { taskId: t.id, actor: "agent", command: { type: "verdict_rework" } }).task.state,
    ).toBe("needs_human");
    // Resuming after exhausted iterations goes back to implementation (there are pending must-fixes), not to
    // verification, and grants a new full cycle of reworks.
    expect(
      apply(db, { taskId: t.id, actor: "human", command: { type: "resume" } }).task,
    ).toMatchObject({ state: "in_progress", subState: "queued", verificationIteration: 0 });
  });

  it("a payload outside the schema does not reach the log and the task stays resumable", () => {
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

  it("pause and resume return the task to the previous state with the iteration and leave two events", () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id, {
      state: "in_progress",
      subState: "running",
      verificationIteration: 2,
    });
    const paused = apply(db, {
      taskId: t.id,
      actor: "human",
      command: { type: "pause", deliveryInProgress: false },
    });
    expect(paused.task).toMatchObject({
      state: "paused",
      subState: null,
      verificationIteration: 2,
    });
    expect(TaskTransitionedPayload.parse(paused.event.payload)).toMatchObject({
      command: "pause",
      from: { state: "in_progress", subState: "running" },
      to: { state: "paused", subState: null },
    });

    const resumed = apply(db, { taskId: t.id, actor: "human", command: { type: "resume" } });
    expect(resumed.task).toMatchObject({
      state: "in_progress",
      subState: "queued",
      verificationIteration: 2,
    });
    expect(
      listEvents(db, t.id).map((e) => TaskTransitionedPayload.parse(e.payload).command),
    ).toEqual(["pause", "resume"]);
  });

  it("resume from paused uses the last pause, not an earlier escalation", () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id, { state: "refined", subState: null });
    apply(db, { taskId: t.id, actor: "system", command: { type: "escalate", reason: "blocked" } });
    apply(db, { taskId: t.id, actor: "human", command: { type: "resume" } });
    apply(db, { taskId: t.id, actor: "human", command: { type: "approve", specApproved: true } });
    apply(db, {
      taskId: t.id,
      actor: "human",
      command: { type: "pause", deliveryInProgress: false },
    });
    expect(
      apply(db, { taskId: t.id, actor: "human", command: { type: "resume" } }).task,
    ).toMatchObject({ state: "in_progress", subState: "queued" });
  });

  it("pause with delivery in progress is rejected with guard_failed and does not write", () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id, {
      state: "verification",
      subState: "running",
    });
    expect(
      transitionTask(db, {
        taskId: t.id,
        actor: "human",
        command: { type: "pause", deliveryInProgress: true },
      }),
    ).toMatchObject({ ok: false, error: { code: "guard_failed" } });
    expect(taskRow(db, t.id)).toMatchObject({ state: "verification", subState: "running" });
    expect(listEvents(db, t.id)).toEqual([]);
  });

  it("a paused task rejects escalate and does not change", () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id, { state: "paused", subState: null });
    expect(
      transitionTask(db, {
        taskId: t.id,
        actor: "system",
        command: { type: "escalate", reason: "blocked" },
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_transition" } });
    expect(taskRow(db, t.id).state).toBe("paused");
    expect(listEvents(db, t.id)).toEqual([]);
  });

  it("resume without a recorded escalation is rejected", () => {
    const db = migratedDatabase();
    const t = insertTask(db, insertProject(db).id, { state: "needs_human", subState: null });
    expect(
      transitionTask(db, { taskId: t.id, actor: "human", command: { type: "resume" } }),
    ).toMatchObject({ ok: false, error: { code: "no_escalation_found" } });
    expect(listEvents(db, t.id)).toEqual([]);
  });
});
