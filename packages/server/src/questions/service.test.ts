import { applyTransition, createQuestion, QuestionRepository } from "@lunasq/db";
import { answerPrompt } from "@lunasq/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { harness, MIN, settle } from "../reconciler/test-helpers.ts";
import { QuestionService } from "./service.ts";

const stops: (() => Promise<void>)[] = [];
beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
});
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  vi.useRealTimers();
});

/** Tarea en refine con el agente vivo que acaba de llamar ask_human. */
async function asked() {
  const h = harness();
  stops.push(h.stop);
  const { taskId, run, name } = await h.launched();
  const question = h.db.transaction((tx) => {
    const moved = applyTransition(tx, {
      taskId,
      actor: "agent",
      command: { type: "ask_human" },
    });
    if (!moved.ok) throw new Error(`ask_human rechazado: ${moved.error.message}`);
    return createQuestion(tx, { taskId, runId: run.id, question: "¿Borro la tabla?" });
  });
  h.herdr.setAgentStatus(name, "idle");
  const service = new QuestionService({
    db: h.db,
    herdr: h.herdr,
    dispatcher: h.dispatcher,
    escalator: h.escalator,
    onError: (error) => h.errors.push({ error, runId: null }),
  });
  return { h, service, taskId, run, name, question };
}

describe("QuestionService.answer", () => {
  it("con el agente vivo manda la respuesta al mismo pane y la tarea sigue en running", async () => {
    const { h, service, taskId, run, name, question } = await asked();

    const result = await service.answer(question.id, {
      answer: "Sí, bórrala",
      answeredBy: "sergio",
    });

    expect(result).toMatchObject({ ok: true, delivery: "pane" });
    expect(await h.herdr.readAgent({ name })).toContain(
      answerPrompt("refine", taskId, { question: "¿Borro la tabla?", answer: "Sí, bórrala" }),
    );
    expect(h.taskRow(taskId)).toMatchObject({ state: "draft", subState: "running" });
    expect(h.runs.get(run.id)?.endedAt).toBeNull();
    expect(new QuestionRepository(h.db).get(question.id)).toMatchObject({
      status: "answered",
      answer: "Sí, bórrala",
      answeredBy: "sergio",
    });
    expect(h.errors).toEqual([]);
  });

  it("una respuesta horas después llega al mismo agente y no vence la fase", async () => {
    const { h, service, taskId, run, name, question } = await asked();
    await vi.advanceTimersByTimeAsync(20 * MIN);
    // El outbox pausa el reloj de fase al pasar a waiting_human.
    h.watcher.onTransition({
      id: 1,
      eventId: 1,
      topic: "task.transitioned",
      taskId,
      actor: "agent",
      payload: {
        command: "ask_human",
        from: { state: "draft", subState: "running" },
        to: { state: "draft", subState: "waiting_human" },
        verificationIteration: 0,
      },
      createdAt: new Date().toISOString(),
    });
    await settle(vi);
    await vi.advanceTimersByTimeAsync(5 * 60 * MIN);
    await settle(vi);
    expect(h.taskRow(taskId)).toMatchObject({ state: "draft", subState: "waiting_human" });
    expect(h.runs.get(run.id)?.endedAt).toBeNull();

    const result = await service.answer(question.id, { answer: "Sí" });
    expect(result).toMatchObject({ ok: true, delivery: "pane" });
    expect(await h.herdr.readAgent({ name })).toContain('Respuesta: "Sí"');
    expect(h.taskRow(taskId)).toMatchObject({ subState: "running" });
  });

  it("sin agente vivo cierra el Run viejo y deja la tarea en queued para un Run nuevo", async () => {
    const { h, service, taskId, run, name, question } = await asked();
    h.herdr.exitAgent(name);
    await settle(vi);

    const result = await service.answer(question.id, { answer: "Sí" });

    expect(result).toMatchObject({ ok: true, delivery: "new_run" });
    expect(h.taskRow(taskId)).toMatchObject({ state: "draft", subState: "queued" });
    expect(h.runs.get(run.id)).toMatchObject({ result: "cancelled" });
    expect(h.runs.get(run.id)?.failureReason).toMatch(/^question_answered:/);
    expect(new QuestionRepository(h.db).get(question.id)?.status).toBe("answered");
    expect(h.errors).toEqual([]);
  });

  it("si el pane de ese nombre ya es otro, no se le manda la respuesta", async () => {
    const { h, service, run, name, question } = await asked();
    vi.spyOn(h.herdr, "getAgent").mockResolvedValue({
      name,
      paneId: `${run.herdrPane}-otro`,
      status: "idle",
    } as never);
    const prompt = vi.spyOn(h.herdr, "promptAgent");

    const result = await service.answer(question.id, { answer: "Sí" });

    expect(result).toMatchObject({ ok: true, delivery: "new_run" });
    expect(prompt).not.toHaveBeenCalled();
  });

  it("si herdr rechaza el prompt, la respuesta se entrega en un Run nuevo", async () => {
    const { h, service, taskId, run, question } = await asked();
    vi.spyOn(h.herdr, "promptAgent").mockRejectedValue(new Error("pane no responde"));

    const result = await service.answer(question.id, { answer: "Sí" });

    expect(result).toMatchObject({ ok: true, delivery: "new_run" });
    expect(h.taskRow(taskId)).toMatchObject({ subState: "queued" });
    expect(h.runs.get(run.id)).toMatchObject({ result: "cancelled" });
  });

  it("responder dos veces a la vez manda un solo prompt", async () => {
    const { h, service, question } = await asked();
    const prompt = vi.spyOn(h.herdr, "promptAgent");

    const [a, b] = await Promise.all([
      service.answer(question.id, { answer: "Sí" }),
      service.answer(question.id, { answer: "No" }),
    ]);

    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect([a, b].find((r) => !r.ok)).toMatchObject({ error: { code: "not_open" } });
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("rechaza una pregunta inexistente o una tarea que ya no espera", async () => {
    const { h, service, taskId, question } = await asked();
    expect(
      await service.answer("00000000-0000-4000-8000-000000000009", { answer: "x" }),
    ).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    h.db.$client
      .prepare("update tasks set state = 'cancelled', sub_state = null where id = ?")
      .run(taskId);
    const prompt = vi.spyOn(h.herdr, "promptAgent");
    expect(await service.answer(question.id, { answer: "x" })).toMatchObject({
      ok: false,
      error: { code: "task_not_waiting" },
    });
    expect(prompt).not.toHaveBeenCalled();
  });

  it("avisa al terminar para que el scheduler despache sin esperar el tick", async () => {
    const { h, question } = await asked();
    const woke = vi.fn();
    const service = new QuestionService({
      db: h.db,
      herdr: h.herdr,
      dispatcher: h.dispatcher,
      escalator: h.escalator,
      onAnswered: woke,
    });
    await service.answer(question.id, { answer: "Sí" });
    expect(woke).toHaveBeenCalledTimes(1);
  });
});
