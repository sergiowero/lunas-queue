import { FakeHerdr, type HerdrEvent, type SubscribeInput } from "@lunasq/adapters";
import { transitionTask } from "@lunasq/db";
import { nudgePrompt } from "@lunasq/domain";
import type { Notification } from "@lunasq/schemas";
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
  it("the agent process ends: failed Run and the task goes back to queued", async () => {
    const h = setup();
    const { taskId, run, name } = await h.launched();
    expect(h.watcher.watching()).toEqual([run.id]);

    h.herdr.exitAgent(name);
    await settle(vi);

    expect(h.runs.get(run.id)).toMatchObject({ result: "failure" });
    expect(h.runs.get(run.id)?.failureReason).toMatch(/^agent_exited: the agent process/);
    expect(h.taskRow(taskId)).toMatchObject({ state: "draft", subState: "queued" });
    expect(h.watcher.watching()).toEqual([]);
    expect(h.errors).toEqual([]);
  });

  it("the pane is closed from outside: failed Run", async () => {
    const h = setup();
    const { taskId, run } = await h.launched();

    await h.herdr.closePane(run.herdrPane ?? "");
    await settle(vi);

    expect(h.runs.get(run.id)?.failureReason).toMatch(/^agent_exited: the pane was closed/);
    expect(h.taskRow(taskId)).toMatchObject({ state: "draft", subState: "queued" });
  });

  it("if an MCP tool already closed the Run, the pane close does not fail it", async () => {
    const h = setup();
    const { taskId, run } = await h.launched();
    h.runs.close(run.id, { result: "success" });

    await h.herdr.closePane(run.herdrPane ?? "");
    await settle(vi);

    expect(h.runs.get(run.id)).toMatchObject({ result: "success", failureReason: null });
    expect(h.taskRow(taskId)).toMatchObject({ subState: "running" });
  });

  it("the dispatcher releases the Run: it stops observing without failing it", async () => {
    const h = setup();
    const { run } = await h.launched();
    await h.dispatcher?.closeRun(run.id, { result: "success" });
    await settle(vi);
    expect(h.watcher.watching()).toEqual([]);
    expect(h.runs.get(run.id)?.result).toBe("success");
  });
});

describe("RunWatcher: agent stopped without an MCP signal", () => {
  it("nudge N times and then failed Run", async () => {
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

  it("if it works again within the grace period there is no nudge", async () => {
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

  it("with the question open (waiting_human) there is no nudge", async () => {
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

  it("a Run closed by an MCP tool receives no nudge", async () => {
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
  it("blocked() lists the agents waiting for a permission until they leave blocked", async () => {
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

  it("notifies once if still blocked for 1 minute and not before", async () => {
    const h = setup();
    const { taskId, run, name } = await h.launched();
    h.herdr.setAgentStatus(name, "blocked");
    await settle(vi);
    await vi.advanceTimersByTimeAsync(ESCALATION_DELAY_MS - 1);
    expect(h.notifications).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(h.notifications).toEqual([
      expect.objectContaining({
        id: `blocked:${run.id}:1`,
        kind: "agent_blocked",
        runId: run.id,
        title: `Blocked agent in #${h.taskRow(taskId)?.number}`,
      }),
    ]);
  });

  it("leaving blocked before the minute cancels the notice; a second block uses another id", async () => {
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

  it("a blocked agent receives no nudge", async () => {
    const h = setup();
    const { taskId, name } = await h.launched();
    h.herdr.setAgentStatus(name, "blocked");
    await settle(vi);
    await vi.advanceTimersByTimeAsync(10 * DEFAULT_NUDGE_GRACE_MS);
    expect(await h.herdr.readAgent({ name })).not.toContain(nudgePrompt("refine", taskId));
  });
});

describe("RunWatcher: phase timeout", () => {
  it("expired: needs_human with phase_timeout, immediate notification and the agent stays alive", async () => {
    const h = setup();
    const { taskId, run, name } = await h.launched();

    await vi.advanceTimersByTimeAsync(30 * MIN);
    await settle(vi);

    expect(h.taskRow(taskId)).toMatchObject({ state: "needs_human", subState: null });
    expect(h.notifications).toEqual([
      expect.objectContaining({
        id: `timeout:${run.id}`,
        kind: "phase_timeout",
        taskId,
        title: `Phase timeout in #${h.taskRow(taskId)?.number}`,
      }),
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

  it("uses the project's timeout for the phase", async () => {
    const h = setup({ project: { limits: { phaseTimeoutMinutes: { refine: 5 } } } });
    const { taskId } = await h.launched();
    await vi.advanceTimersByTimeAsync(5 * MIN);
    await settle(vi);
    expect(h.taskRow(taskId)).toMatchObject({ state: "needs_human" });
  });

  it("it pauses while the agent is blocked", async () => {
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

  it("it pauses while the task is in waiting_human", async () => {
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

describe("RunWatcher: usage limit", () => {
  const CLAUDE_LIMIT_SCREEN =
    "trabajo en curso…\nUsage limit reached · limit resets 3:45pm\nContinuing automatically at 3:45pm · Esc to cancel";

  function usageNotification(notifications: Notification[]) {
    const last = notifications[notifications.length - 1];
    if (last?.kind !== "usage_limit") throw new Error("no usage_limit notification");
    return last;
  }

  it("agent stopped with the notice on screen: needs_human with usage_limit, without nudge or failure", async () => {
    const h = setup();
    const { taskId, run, name } = await h.launched();
    h.herdr.setAgentScreen(name, CLAUDE_LIMIT_SCREEN);
    h.herdr.setAgentStatus(name, "idle");

    await vi.advanceTimersByTimeAsync(DEFAULT_NUDGE_GRACE_MS);
    await settle(vi);

    expect(h.taskRow(taskId)).toMatchObject({ state: "needs_human", subState: null });
    expect(await h.herdr.readAgent({ name })).not.toContain(nudgePrompt("refine", taskId));
    expect(usageNotification(h.notifications)).toMatchObject({
      id: `usage:${run.id}`,
      kind: "usage_limit",
      runId: run.id,
      taskId,
    });
    expect(usageNotification(h.notifications).body).toContain("3:45pm");
    expect(h.runs.get(run.id)?.endedAt).toBeNull();
    expect(await h.herdr.getAgent(name)).toBeDefined();
    expect(h.errors).toEqual([]);
    const event = h.db.$client
      .prepare("select payload from events where task_id = ? order by id desc limit 1")
      .get(taskId) as { payload: string };
    expect(JSON.parse(event.payload)).toEqual({
      command: "escalate",
      from: { state: "draft", subState: "running" },
      to: { state: "needs_human", subState: null },
      verificationIteration: 0,
      reason: "usage_limit",
      note: `Agent ${name} (refine) ran out of usage: Usage limit reached · limit resets 3:45pm · Continuing automatically at 3:45pm · Esc to cancel`,
    });
  });

  it("the agent's own work that mentions limits does not trigger the escalation: the normal path continues", async () => {
    const h = setup();
    const { taskId, name } = await h.launched();
    h.herdr.setAgentScreen(name, "Reviso los rate limits del poller antes de seguir");
    h.herdr.setAgentStatus(name, "idle");

    await vi.advanceTimersByTimeAsync(DEFAULT_NUDGE_GRACE_MS);
    await settle(vi);

    expect(h.taskRow(taskId)).toMatchObject({ subState: "running" });
    expect(h.notifications).toEqual([]);
    h.herdr.setAgentScreen(name, undefined);
    expect(await h.herdr.readAgent({ name })).toContain(nudgePrompt("refine", taskId));
  });

  it("the limit notice as a menu (blocked) escalates instead of reporting a blocked agent", async () => {
    const h = setup();
    const { taskId, run, name } = await h.launched();
    h.herdr.setAgentScreen(
      name,
      "Usage limit reached · limit resets 3:45pm\n❯ 1. Wait for your limit to reset\n   2. Add usage credits\n Enter to select · Esc to cancel",
    );
    h.herdr.setAgentStatus(name, "blocked");

    await settle(vi);
    expect(h.taskRow(taskId)).toMatchObject({ state: "needs_human", subState: null });
    expect(h.watcher.blocked()).toEqual([]);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    await settle(vi);
    expect(h.notifications).toEqual([
      expect.objectContaining({ id: `usage:${run.id}`, kind: "usage_limit" }),
    ]);
  });

  it("once escalated, more signals from the same agent do not duplicate the escalation", async () => {
    const h = setup();
    const { taskId, run, name } = await h.launched();
    h.herdr.setAgentScreen(name, CLAUDE_LIMIT_SCREEN);
    h.herdr.setAgentStatus(name, "idle");
    await vi.advanceTimersByTimeAsync(DEFAULT_NUDGE_GRACE_MS);
    await settle(vi);
    expect(h.taskRow(taskId)).toMatchObject({ state: "needs_human" });
    expect(h.notifications).toEqual([
      expect.objectContaining({ id: `usage:${run.id}`, kind: "usage_limit" }),
    ]);

    h.herdr.setAgentStatus(name, "working");
    await settle(vi);
    expect(h.taskRow(taskId)).toMatchObject({ state: "needs_human" });
    expect(h.notifications).toHaveLength(1);
  });
});

describe("RunWatcher: lost events", () => {
  it("a stream cut requests reconciling and re-reads the agent's state", async () => {
    const h = setup();
    const { taskId, name } = await h.launched();
    h.herdr.dropStreams();
    await settle(vi);
    expect(h.lost()).toBeGreaterThan(0);
    expect(h.taskRow(taskId)).toMatchObject({ subState: "running" });
    expect(await h.herdr.getAgent(name)).toBeDefined();
  });
});

describe("RunWatcher: Runs that are not failed", () => {
  it("with a saved handoff (verifier pass): no nudge, no failure, no timeout", async () => {
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

  it("a crash with the question open leaves the Run open for the answer (UW-22)", async () => {
    const h = setup();
    const { taskId, run, name } = await h.launched();
    transitionTask(h.db, { taskId, actor: "agent", command: { type: "ask_human" } });

    h.herdr.exitAgent(name);
    await settle(vi);

    expect(h.runs.get(run.id)).toMatchObject({ endedAt: null, result: null });
    expect(h.taskRow(taskId)).toMatchObject({ subState: "waiting_human" });
    expect(h.watcher.watching()).toEqual([]);
  });

  it("a timeout that expires with the question open before the outbox escalates on answering", async () => {
    const h = setup();
    const { taskId } = await h.launched();
    // ask_human without notifying the watcher: the outbox has not delivered it yet.
    transitionTask(h.db, { taskId, actor: "agent", command: { type: "ask_human" } });
    await vi.advanceTimersByTimeAsync(30 * MIN);
    await settle(vi);
    expect(h.taskRow(taskId)).toMatchObject({ subState: "waiting_human" });

    transitionTask(h.db, { taskId, actor: "human", command: { type: "answer", agentAlive: true } });
    h.watcher.onTransition(transitionMessage(taskId));
    await settle(vi);
    expect(h.taskRow(taskId)).toMatchObject({ state: "needs_human" });
  });

  it("a subscription rejected for another reason requests reconciling instead of failing the Run", async () => {
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
