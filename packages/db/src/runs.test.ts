import { describe, expect, it } from "vitest";
import { listEvents } from "./event-log.ts";
import {
  appendChecklist,
  closeRun,
  consecutiveFailures,
  createQuestion,
  latestChecklist,
  listQuestions,
  RunRepository,
} from "./runs.ts";
import { transitionTask } from "./task-transitions.ts";
import { insertProject, insertRun, insertTask, migratedDatabase } from "./test-helpers.ts";

function setup() {
  const db = migratedDatabase();
  const project = insertProject(db);
  const task = insertTask(db, project.id, { state: "in_progress", subState: "running" });
  return { db, project, task, repo: new RunRepository(db) };
}

describe("RunRepository", () => {
  it("activeByToken solo encuentra Runs sin ended_at", () => {
    const { db, task, repo } = setup();
    const old = insertRun(db, task.id, {
      runToken: "viejo",
      endedAt: new Date(),
      result: "failure",
    });
    const active = insertRun(db, task.id, { runToken: "vigente" });
    expect(repo.activeByToken("vigente")?.id).toBe(active.id);
    expect(repo.activeByToken(old.runToken)).toBeNull();
    expect(repo.activeByToken("desconocido")).toBeNull();
  });

  it("markContextRead guarda la primera lectura y no la mueve al repetir", () => {
    const { db, task, repo } = setup();
    const run = insertRun(db, task.id);
    const first = repo.markContextRead(run.id);
    const again = repo.markContextRead(run.id);
    expect(first).toBeInstanceOf(Date);
    expect(again?.getTime()).toBe(first?.getTime());
    expect(repo.get(run.id)?.contextReadAt?.getTime()).toBe(first?.getTime());
  });

  it("closeRun cierra una sola vez con resultado, motivo y handoff", () => {
    const { db, task, repo } = setup();
    const run = insertRun(db, task.id);
    const handoff = { phase: "implementation" };
    expect(closeRun(db, run.id, { result: "success", handoff })).toBe(true);
    expect(closeRun(db, run.id, { result: "failure", failureReason: "otra" })).toBe(false);
    expect(repo.get(run.id)).toMatchObject({ result: "success", handoff, failureReason: null });
    expect(repo.get(run.id)?.endedAt).toBeInstanceOf(Date);
  });

  it("recordHandoff guarda el handoff y deja el Run abierto", () => {
    const { db, task, repo } = setup();
    const run = insertRun(db, task.id, { phase: "verify" });
    repo.recordHandoff(run.id, { phase: "verification" });
    expect(repo.get(run.id)).toMatchObject({ handoff: { phase: "verification" }, endedAt: null });
  });

  it("latestHandoffs devuelve los handoffs de la fase, del más viejo al más nuevo", () => {
    const { db, task, repo } = setup();
    const first = insertRun(db, task.id, { phase: "verify", startedAt: new Date(1000) });
    closeRun(db, first.id, { result: "success", handoff: { n: 1 } });
    const failed = insertRun(db, task.id, { phase: "verify", startedAt: new Date(2000) });
    closeRun(db, failed.id, { result: "failure", failureReason: "x" });
    const second = insertRun(db, task.id, { phase: "verify", startedAt: new Date(3000) });
    closeRun(db, second.id, { result: "success", handoff: { n: 2 } });
    expect(repo.handoffs(task.id, "verify")).toEqual([{ n: 1 }, { n: 2 }]);
    expect(repo.handoffs(task.id, "implement")).toEqual([]);
  });

  it("previousRun es el último Run cerrado de la fase, sin contar el actual", () => {
    const { db, task, repo } = setup();
    const failed = insertRun(db, task.id, { startedAt: new Date(1000) });
    closeRun(db, failed.id, { result: "failure", failureReason: "no compila" });
    const current = insertRun(db, task.id, { startedAt: new Date(2000) });
    expect(repo.previousRun(task.id, "implement", current.id)).toMatchObject({
      id: failed.id,
      failureReason: "no compila",
    });
    expect(repo.previousRun(task.id, "refine", current.id)).toBeNull();
  });
});

describe("consecutiveFailures", () => {
  it("cuenta los Runs fallidos seguidos de la fase hasta uno que no falló", () => {
    const { db, task } = setup();
    const ok = insertRun(db, task.id, { startedAt: new Date(1000) });
    closeRun(db, ok.id, { result: "success" });
    for (const at of [2000, 3000]) {
      const run = insertRun(db, task.id, { startedAt: new Date(at) });
      closeRun(db, run.id, { result: "failure", failureReason: "x" });
    }
    const other = insertRun(db, task.id, { phase: "verify", startedAt: new Date(4000) });
    closeRun(db, other.id, { result: "failure", failureReason: "x" });
    expect(consecutiveFailures(db, task.id, "implement")).toBe(2);
    expect(consecutiveFailures(db, task.id, "verify")).toBe(1);
  });

  it("un resume reinicia la cuenta", () => {
    const { db, project } = setup();
    const task = insertTask(db, project.id, { state: "in_progress", subState: "running" });
    const failed = insertRun(db, task.id, { startedAt: new Date(1000) });
    closeRun(db, failed.id, { result: "failure", failureReason: "x" });
    const escalated = transitionTask(db, {
      taskId: task.id,
      actor: "system",
      command: { type: "escalate", reason: "retries_exhausted" },
    });
    expect(escalated.ok).toBe(true);
    const resumed = transitionTask(db, {
      taskId: task.id,
      actor: "human",
      command: { type: "resume" },
    });
    expect(resumed.ok).toBe(true);
    expect(consecutiveFailures(db, task.id, "implement")).toBe(0);
  });
});

describe("Questions y checklist", () => {
  it("createQuestion guarda la pregunta abierta y su evento", () => {
    const { db, task } = setup();
    const run = insertRun(db, task.id);
    const question = createQuestion(db, {
      taskId: task.id,
      runId: run.id,
      question: "¿Uso la tabla vieja?",
      context: "hay dos",
    });
    expect(question).toMatchObject({ status: "open", runId: run.id, answer: null });
    expect(listQuestions(db, task.id).map((q) => q.id)).toEqual([question.id]);
    expect(listEvents(db, task.id).at(-1)).toMatchObject({
      type: "question.created",
      actor: "agent",
      payload: { questionId: question.id, runId: run.id },
    });
  });

  it("latestChecklist es el último snapshot de la tarea", () => {
    const { db, task } = setup();
    const run = insertRun(db, task.id);
    expect(latestChecklist(db, task.id)).toBeNull();
    appendChecklist(db, task.id, run.id, [{ taskId: "T-1", title: "a", done: false }]);
    appendChecklist(db, task.id, run.id, [{ taskId: "T-1", title: "a", done: true }]);
    expect(latestChecklist(db, task.id)).toEqual([{ taskId: "T-1", title: "a", done: true }]);
  });
});
