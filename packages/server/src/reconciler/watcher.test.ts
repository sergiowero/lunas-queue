import { FakeHerdr, type HerdrEvent, type SubscribeInput } from "@lunasq/adapters";
import { transitionTask } from "@lunasq/db";
import { nudgePrompt } from "@lunasq/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ESCALATION_DELAY_MS } from "../notifications/escalator.ts";
import { harness, MIN, SEC, settle } from "./test-helpers.ts";
import { DEFAULT_MAX_NUDGES, DEFAULT_NUDGE_GRACE_MS } from "./watcher.ts";

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

function setup(opts: Parameters<typeof harness>[0] = {}) {
  const h = harness(opts);
  stops.push(h.stop);
  return h;
}

describe("RunWatcher: crash", () => {
  it("el proceso del agente termina: Run fallido y la tarea vuelve a queued", async () => {
    const h = setup();
    const { taskId, run, name } = await h.launched();
    expect(h.watcher.watching()).toEqual([run.id]);

    h.herdr.exitAgent(name);
    await settle(vi);

    expect(h.runs.get(run.id)).toMatchObject({ result: "failure" });
    expect(h.runs.get(run.id)?.failureReason).toMatch(/^agent_exited: el proceso del agente/);
    expect(h.taskRow(taskId)).toMatchObject({ state: "draft", subState: "queued" });
    expect(h.watcher.watching()).toEqual([]);
    expect(h.errors).toEqual([]);
  });

  it("el pane se cierra desde afuera: Run fallido", async () => {
    const h = setup();
    const { taskId, run } = await h.launched();

    await h.herdr.closePane(run.herdrPane ?? "");
    await settle(vi);

    expect(h.runs.get(run.id)?.failureReason).toMatch(/^agent_exited: el pane se cerró/);
    expect(h.taskRow(taskId)).toMatchObject({ state: "draft", subState: "queued" });
  });

  it("si una tool del MCP ya cerró el Run, el cierre del pane no lo falla", async () => {
    const h = setup();
    const { taskId, run } = await h.launched();
    h.runs.close(run.id, { result: "success" });

    await h.herdr.closePane(run.herdrPane ?? "");
    await settle(vi);

    expect(h.runs.get(run.id)).toMatchObject({ result: "success", failureReason: null });
    expect(h.taskRow(taskId)).toMatchObject({ subState: "running" });
  });

  it("el dispatcher libera el Run: deja de observar sin fallarlo", async () => {
    const h = setup();
    const { run } = await h.launched();
    await h.dispatcher?.closeRun(run.id, { result: "success" });
    await settle(vi);
    expect(h.watcher.watching()).toEqual([]);
    expect(h.runs.get(run.id)?.result).toBe("success");
  });
});

describe("RunWatcher: agente detenido sin señal MCP", () => {
  it("nudge N veces y luego Run fallido", async () => {
    const h = setup();
    const { taskId, run, name } = await h.launched();

    for (let n = 1; n <= DEFAULT_MAX_NUDGES; n++) {
      h.herdr.setAgentStatus(name, "done");
      await settle(vi);
      await vi.advanceTimersByTimeAsync(DEFAULT_NUDGE_GRACE_MS);
      await settle(vi);
      const screen = await h.herdr.readAgent({ name });
      expect(screen.split(nudgePrompt("refine", taskId)).length - 1).toBe(n);
      expect(h.runs.get(run.id)?.endedAt).toBeNull();
    }

    h.herdr.setAgentStatus(name, "idle");
    await settle(vi);
    await vi.advanceTimersByTimeAsync(DEFAULT_NUDGE_GRACE_MS);
    await settle(vi);

    expect(h.runs.get(run.id)?.failureReason).toMatch(/^agent_stopped:/);
    expect(h.taskRow(taskId)).toMatchObject({ state: "draft", subState: "queued" });
    expect(await h.herdr.getAgent(name)).toBeUndefined();
  });

  it("si vuelve a trabajar dentro de la gracia no hay nudge", async () => {
    const h = setup();
    const { taskId, name } = await h.launched();
    h.herdr.setAgentStatus(name, "idle");
    await settle(vi);
    await vi.advanceTimersByTimeAsync(DEFAULT_NUDGE_GRACE_MS / 2);
    h.herdr.setAgentStatus(name, "working");
    await settle(vi);
    await vi.advanceTimersByTimeAsync(DEFAULT_NUDGE_GRACE_MS);
    await settle(vi);
    expect(await h.herdr.readAgent({ name })).not.toContain(nudgePrompt("refine", taskId));
  });

  it("con la pregunta abierta (waiting_human) no hay nudge", async () => {
    const h = setup();
    const { taskId, name } = await h.launched();
    const asked = transitionTask(h.db, { taskId, actor: "agent", command: { type: "ask_human" } });
    expect(asked.ok).toBe(true);
    h.herdr.setAgentStatus(name, "idle");
    await settle(vi);
    await vi.advanceTimersByTimeAsync(10 * DEFAULT_NUDGE_GRACE_MS);
    await settle(vi);
    expect(await h.herdr.readAgent({ name })).not.toContain(nudgePrompt("refine", taskId));
    expect(h.taskRow(taskId)).toMatchObject({ subState: "waiting_human" });
  });

  it("el Run cerrado por una tool del MCP no recibe nudge", async () => {
    const h = setup();
    const { taskId, run, name } = await h.launched();
    h.runs.close(run.id, { result: "success" });
    h.herdr.setAgentStatus(name, "done");
    await settle(vi);
    await vi.advanceTimersByTimeAsync(DEFAULT_NUDGE_GRACE_MS);
    await settle(vi);
    expect(await h.herdr.readAgent({ name })).not.toContain(nudgePrompt("refine", taskId));
  });
});

describe("RunWatcher: blocked", () => {
  it("blocked() lista los agentes que esperan un permiso hasta que salen de blocked", async () => {
    const h = setup();
    const { taskId, run, name } = await h.launched();
    expect(h.watcher.blocked()).toEqual([]);

    h.herdr.setAgentStatus(name, "blocked");
    await settle(vi);
    expect(h.watcher.blocked()).toEqual([
      {
        runId: run.id,
        taskId,
        phase: "refine",
        agentName: name,
        paneId: run.herdrPane,
        since: new Date().toISOString(),
      },
    ]);

    h.herdr.setAgentStatus(name, "working");
    await settle(vi);
    expect(h.watcher.blocked()).toEqual([]);
  });

  it("notifica una vez si sigue bloqueado 1 minuto y no antes", async () => {
    const h = setup();
    const { run, name } = await h.launched();
    h.herdr.setAgentStatus(name, "blocked");
    await settle(vi);
    await vi.advanceTimersByTimeAsync(ESCALATION_DELAY_MS - 1);
    expect(h.notifications).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(h.notifications).toEqual([
      expect.objectContaining({ id: `blocked:${run.id}:1`, kind: "agent_blocked", runId: run.id }),
    ]);
  });

  it("salir de blocked antes del minuto cancela el aviso; un segundo bloqueo usa otro id", async () => {
    const h = setup();
    const { run, name } = await h.launched();
    h.herdr.setAgentStatus(name, "blocked");
    await settle(vi);
    await vi.advanceTimersByTimeAsync(30 * SEC);
    h.herdr.setAgentStatus(name, "working");
    await settle(vi);
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(h.notifications).toEqual([]);

    h.herdr.setAgentStatus(name, "blocked");
    await settle(vi);
    await vi.advanceTimersByTimeAsync(ESCALATION_DELAY_MS);
    expect(h.notifications.map((n) => n.id)).toEqual([`blocked:${run.id}:2`]);
  });

  it("un agente bloqueado no recibe nudge", async () => {
    const h = setup();
    const { taskId, name } = await h.launched();
    h.herdr.setAgentStatus(name, "blocked");
    await settle(vi);
    await vi.advanceTimersByTimeAsync(10 * DEFAULT_NUDGE_GRACE_MS);
    expect(await h.herdr.readAgent({ name })).not.toContain(nudgePrompt("refine", taskId));
  });
});

describe("RunWatcher: timeout de fase", () => {
  it("vencido: needs_human con phase_timeout, notificación inmediata y el agente sigue vivo", async () => {
    const h = setup();
    const { taskId, run, name } = await h.launched();

    await vi.advanceTimersByTimeAsync(30 * MIN);
    await settle(vi);

    expect(h.taskRow(taskId)).toMatchObject({ state: "needs_human", subState: null });
    expect(h.notifications).toEqual([
      expect.objectContaining({ id: `timeout:${run.id}`, kind: "phase_timeout", taskId }),
    ]);
    expect(await h.herdr.getAgent(name)).toBeDefined();
    expect(h.runs.get(run.id)?.endedAt).toBeNull();
    const event = h.db.$client
      .prepare("select payload from events where task_id = ? order by id desc limit 1")
      .get(taskId) as { payload: string };
    expect(JSON.parse(event.payload)).toMatchObject({
      command: "escalate",
      reason: "phase_timeout",
    });
  });

  it("usa el timeout del proyecto para la fase", async () => {
    const h = setup({ project: { limits: { phaseTimeoutMinutes: { refine: 5 } } } });
    const { taskId } = await h.launched();
    await vi.advanceTimersByTimeAsync(5 * MIN);
    await settle(vi);
    expect(h.taskRow(taskId)).toMatchObject({ state: "needs_human" });
  });

  it("se pausa mientras el agente está blocked", async () => {
    const h = setup();
    const { taskId, name } = await h.launched();
    await vi.advanceTimersByTimeAsync(20 * MIN);
    h.herdr.setAgentStatus(name, "blocked");
    await settle(vi);
    await vi.advanceTimersByTimeAsync(2 * 60 * MIN);
    expect(h.taskRow(taskId)).toMatchObject({ state: "draft", subState: "running" });
    h.herdr.setAgentStatus(name, "working");
    await settle(vi);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    await settle(vi);
    expect(h.taskRow(taskId)).toMatchObject({ state: "needs_human" });
  });

  it("se pausa mientras la tarea está en waiting_human", async () => {
    const h = setup();
    const { taskId } = await h.launched();
    await vi.advanceTimersByTimeAsync(20 * MIN);
    transitionTask(h.db, { taskId, actor: "agent", command: { type: "ask_human" } });
    h.watcher.onTransition(transitionMessage(taskId));
    await settle(vi);
    await vi.advanceTimersByTimeAsync(2 * 60 * MIN);
    expect(h.taskRow(taskId)).toMatchObject({ subState: "waiting_human" });

    transitionTask(h.db, {
      taskId,
      actor: "human",
      command: { type: "answer", agentAlive: true },
    });
    h.watcher.onTransition(transitionMessage(taskId));
    await settle(vi);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    await settle(vi);
    expect(h.taskRow(taskId)).toMatchObject({ state: "needs_human" });
  });
});

describe("RunWatcher: eventos perdidos", () => {
  it("un corte del stream pide reconciliar y relee el estado del agente", async () => {
    const h = setup();
    const { taskId, name } = await h.launched();
    h.herdr.dropStreams();
    await settle(vi);
    expect(h.lost()).toBeGreaterThan(0);
    expect(h.taskRow(taskId)).toMatchObject({ subState: "running" });
    expect(await h.herdr.getAgent(name)).toBeDefined();
  });
});

describe("RunWatcher: Runs que no se fallan", () => {
  it("con handoff guardado (pass del verificador): ni nudge, ni fallo, ni timeout", async () => {
    const h = setup();
    const { taskId, run, name } = await h.launched();
    h.runs.recordHandoff(run.id, { verdict: "pass" });

    h.herdr.setAgentStatus(name, "done");
    await settle(vi);
    await vi.advanceTimersByTimeAsync(10 * DEFAULT_NUDGE_GRACE_MS);
    await settle(vi);
    expect(await h.herdr.readAgent({ name })).not.toContain(nudgePrompt("refine", taskId));

    await vi.advanceTimersByTimeAsync(60 * MIN);
    await settle(vi);
    expect(h.taskRow(taskId)).toMatchObject({ state: "draft", subState: "running" });
    expect(h.notifications).toEqual([]);

    h.herdr.exitAgent(name);
    await settle(vi);
    expect(h.runs.get(run.id)).toMatchObject({ endedAt: null, result: null });
    expect(h.taskRow(taskId)).toMatchObject({ subState: "running" });
  });

  it("un crash con la pregunta abierta deja el Run abierto para la respuesta (UW-22)", async () => {
    const h = setup();
    const { taskId, run, name } = await h.launched();
    transitionTask(h.db, { taskId, actor: "agent", command: { type: "ask_human" } });

    h.herdr.exitAgent(name);
    await settle(vi);

    expect(h.runs.get(run.id)).toMatchObject({ endedAt: null, result: null });
    expect(h.taskRow(taskId)).toMatchObject({ subState: "waiting_human" });
    expect(h.watcher.watching()).toEqual([]);
  });

  it("un timeout que vence con la pregunta abierta antes del outbox escala al responder", async () => {
    const h = setup();
    const { taskId } = await h.launched();
    // ask_human sin avisar al watcher: el outbox todavía no lo entregó.
    transitionTask(h.db, { taskId, actor: "agent", command: { type: "ask_human" } });
    await vi.advanceTimersByTimeAsync(30 * MIN);
    await settle(vi);
    expect(h.taskRow(taskId)).toMatchObject({ subState: "waiting_human" });

    transitionTask(h.db, { taskId, actor: "human", command: { type: "answer", agentAlive: true } });
    h.watcher.onTransition(transitionMessage(taskId));
    await settle(vi);
    expect(h.taskRow(taskId)).toMatchObject({ state: "needs_human" });
  });

  it("una suscripción rechazada por otro motivo pide reconciliar en vez de fallar el Run", async () => {
    class FlakyHerdr extends FakeHerdr {
      override subscribe(input: SubscribeInput, onEvent: (event: HerdrEvent) => void) {
        if (!input.paneIds) return super.subscribe(input, onEvent);
        queueMicrotask(() =>
          onEvent({ type: "subscription_failed", code: "protocol_error", message: "x" }),
        );
        return { close: async () => {} };
      }
    }
    const h = setup({ herdr: new FlakyHerdr({ promptDurationMs: 20 * 24 * 60 * MIN }) });
    const { run } = await h.launched();
    await settle(vi);
    expect(h.runs.get(run.id)?.endedAt).toBeNull();
    expect(h.lost()).toBeGreaterThan(0);
  });
});

let messageId = 0;
function transitionMessage(taskId: string) {
  messageId += 1;
  return {
    id: messageId,
    eventId: messageId,
    topic: "task.transitioned",
    taskId,
    actor: "system" as const,
    payload: {
      command: "ask_human",
      from: { state: "draft", subState: "running" },
      to: { state: "draft", subState: "waiting_human" },
      verificationIteration: 0,
    },
    createdAt: new Date().toISOString(),
  };
}
