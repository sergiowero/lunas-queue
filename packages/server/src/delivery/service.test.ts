import { FakeGit } from "@lunasq/adapters";
import {
  appendEvent,
  listEvents,
  RunRepository,
  TaskPrRepository,
  TaskRepository,
} from "@lunasq/db";
import { setTaskPosition } from "@lunasq/db/test-helpers";
import { DELIVERY_CONFLICT, TASK_PR_OPENED, TASK_TRANSITIONED } from "@lunasq/schemas";
import { describe, expect, it } from "vitest";
import { OutboxPublisher } from "../outbox/publisher.ts";
import { subscribeDelivery } from "./subscribe.ts";
import { BRANCH, deliveryHarness, WORKTREE } from "./test-helpers.ts";

const eventsOf = (h: ReturnType<typeof deliveryHarness>, type: string) =>
  listEvents(h.db, h.task.id).filter((e) => e.type === type);

describe("DeliveryService.deliver", () => {
  it("a task with a pass ends in a PR with trailers and a risk label", async () => {
    const h = deliveryHarness();
    await h.agentCommits();
    h.baseMoves({ "CHANGELOG.md": { content: "v2\n" } });

    const result = await h.service.deliver(h.task.id);

    expect(result).toMatchObject({ status: "delivered", created: true });
    // Delivery order: hook, pending evidence, rebase, trailers, final suite, closing the
    // Run and evidence, push, PR with its label and after_delivery.
    expect(h.calls).toEqual([
      "hook:before_delivery",
      "evidence",
      "rebase",
      "addTrailers",
      "gate",
      "close_run",
      "evidence",
      "push",
      "createPr",
      "addLabels",
      "hook:after_delivery",
    ]);
    expect(h.testGate.calls).toMatchObject([
      { trigger: "delivery", command: "pnpm test", worktreePath: WORKTREE, runId: h.verify.id },
    ]);

    // The published branch carries the agent's commits with the task and Run trailers.
    const commits = await h.git.listCommits({ cwd: WORKTREE, base: "origin/main" });
    expect(commits).toHaveLength(2);
    for (const commit of commits) {
      expect(commit.message).toContain(`LunasQ-Task: ${h.task.id}`);
      expect(commit.message).toContain(`LunasQ-Run: ${h.implement.id}`);
    }
    expect(h.git.remoteBranch(WORKTREE, BRANCH)).toBe(
      await h.git.resolveCommit({ cwd: WORKTREE, ref: "HEAD" }),
    );

    // The PR carries intent, criteria, evidence, risk and trailers, and its label.
    const [input] = h.github.created;
    expect(input).toMatchObject({ cwd: WORKTREE, head: BRANCH, base: "main" });
    expect(input?.title).toBe("Permitir cancelar pedidos pendientes");
    expect(input?.body).toContain("Permitir cancelar pedidos pendientes");
    expect(input?.body).toContain("AC-1");
    expect(input?.body).toContain("Risk: **low**");
    expect(input?.body).toContain(`LunasQ-Task: ${h.task.id}`);
    expect(input?.body).toContain(`LunasQ-Run: ${h.verify.id}`);
    expect(result.status === "delivered" && (await h.github.getPr(result.prUrl)).labels).toEqual([
      "lunasq:risk-low",
    ]);

    // The task ends up completed with its open PR recorded and the verifier's Run closed.
    expect(h.taskNow()).toMatchObject({ state: "completed", prState: "open" });
    expect(h.taskNow()?.prUrl).toBe(result.status === "delivered" ? result.prUrl : "");
    expect(eventsOf(h, TASK_PR_OPENED)).toHaveLength(1);
    expect(h.closedRuns).toEqual([h.verify.id]);
    expect(new RunRepository(h.db).get(h.verify.id)).toMatchObject({ result: "success" });
    // Committed before the rebase and again after closing the verifier's Run (idempotent).
    expect(h.evidenceCommits).toEqual([h.task.id, h.task.id]);
    expect(h.hooks.calls.at(-1)).toMatchObject({
      point: "after_delivery",
      runId: h.verify.id,
      prUrl: result.status === "delivered" ? result.prUrl : "",
    });
  });

  it("repeating it with the task already completed does not create another PR", async () => {
    const h = deliveryHarness();
    await h.agentCommits();
    await h.service.deliver(h.task.id);
    const again = await h.service.deliver(h.task.id);
    expect(again).toEqual({ status: "skipped", reason: "not_delivering" });
    expect(h.github.created).toHaveLength(1);
  });

  it("resumed after a crash (Run already closed, PR already created) completes with the same PR", async () => {
    const h = deliveryHarness({ verifierClosed: true });
    await h.agentCommits();
    const pr = await h.github.createPr({
      cwd: WORKTREE,
      head: BRANCH,
      base: "main",
      title: "ya existe",
      body: "b",
    });

    const result = await h.service.deliver(h.task.id);

    expect(result).toMatchObject({ status: "delivered", created: false, prUrl: pr.pr.url });
    expect(h.taskNow()).toMatchObject({ state: "completed", prUrl: pr.pr.url });
    // The Run was already closed: it is not closed again.
    expect(h.closedRuns).toEqual([]);
  });

  it("without a test command there is no green gate: the delivery stops", async () => {
    const h = deliveryHarness({ testCommand: null });
    await h.agentCommits();
    h.testGate.result = { passed: false, output: "the project has no test command" };
    const result = await h.service.deliver(h.task.id);
    expect(result).toMatchObject({ status: "conflict", reason: "tests_failed" });
    expect(h.git.remoteBranch(WORKTREE, BRANCH)).toBeNull();
  });

  it("a conflict when integrating the base sends the task back to in_progress without raising the iteration", async () => {
    const h = deliveryHarness();
    // Same file the base changed.
    h.git.writeWorkingFile(WORKTREE, "src/a.ts");
    await h.git.commitAll({ cwd: WORKTREE, message: "feat: a", trailers: {} });
    h.baseMoves({ "src/a.ts": { content: "otra versión\n" } });

    const result = await h.service.deliver(h.task.id);

    expect(result).toEqual({ status: "conflict", reason: "rebase_conflict" });
    expect(h.taskNow()).toMatchObject({
      state: "in_progress",
      subState: "queued",
      verificationIteration: 0,
    });
    const [event] = eventsOf(h, DELIVERY_CONFLICT);
    expect(event?.payload).toEqual({
      runId: h.verify.id,
      reason: "rebase_conflict",
      baseBranch: "main",
      files: ["src/a.ts"],
      output: null,
    });
    // Without suite, push or PR; the verifier's Run was closed successfully to leave its evidence.
    expect(h.calls).toEqual([
      "hook:before_delivery",
      "evidence",
      "rebase",
      "close_run",
      "evidence",
    ]);
    expect(h.github.created).toEqual([]);
    expect(new RunRepository(h.db).get(h.verify.id)).toMatchObject({ result: "success" });
    const transitioned = eventsOf(h, TASK_TRANSITIONED).at(-1)?.payload as { command: string };
    expect(transitioned.command).toBe("delivery_conflict");
  });

  it("a red suite after the rebase also sends the task back, with the tail of the output", async () => {
    const h = deliveryHarness();
    await h.agentCommits();
    h.testGate.result = { passed: false, output: "FAIL src/a.test.ts\n1 failed" };

    const result = await h.service.deliver(h.task.id);

    expect(result).toEqual({ status: "conflict", reason: "tests_failed" });
    expect(h.taskNow()).toMatchObject({ state: "in_progress", verificationIteration: 0 });
    expect(eventsOf(h, DELIVERY_CONFLICT)[0]?.payload).toMatchObject({
      reason: "tests_failed",
      files: [],
      output: "FAIL src/a.test.ts\n1 failed",
    });
    expect(h.git.remoteBranch(WORKTREE, BRANCH)).toBeNull();
    expect(h.github.created).toEqual([]);
  });

  it("after as many conflicts as verification iterations, it escalates to needs_human", async () => {
    const h = deliveryHarness();
    await h.agentCommits();
    h.testGate.result = { passed: false, output: "1 failed" };
    for (let i = 0; i < 2; i++) {
      appendEvent(h.db, {
        taskId: h.task.id,
        type: DELIVERY_CONFLICT,
        actor: "system",
        payload: {
          runId: h.verify.id,
          reason: "tests_failed",
          baseBranch: "main",
          files: [],
          output: "x",
        },
      });
    }
    // With 2 previous conflicts and cap 3, the third still goes back to implementation...
    expect((await h.service.deliver(h.task.id)).status).toBe("conflict");

    const second = deliveryHarness();
    await second.agentCommits();
    second.testGate.result = { passed: false, output: "1 failed" };
    for (let i = 0; i < 3; i++) {
      appendEvent(second.db, {
        taskId: second.task.id,
        type: DELIVERY_CONFLICT,
        actor: "system",
        payload: {
          runId: second.verify.id,
          reason: "tests_failed",
          baseBranch: "main",
          files: [],
          output: "x",
        },
      });
    }
    // ...and the fourth does not.
    const result = await second.service.deliver(second.task.id);
    expect(result).toMatchObject({ status: "escalated" });
    expect(second.taskNow()).toMatchObject({ state: "needs_human" });
    const escalation = eventsOf(second, TASK_TRANSITIONED).at(-1)?.payload;
    expect(escalation).toMatchObject({ command: "escalate", reason: "delivery_failed" });
  });

  it("a delivered PR that ends up in conflict is delivered again on the same PR, with the conflict count from zero", async () => {
    const h = deliveryHarness();
    await h.agentCommits();
    for (let i = 0; i < 3; i++) {
      appendEvent(h.db, {
        taskId: h.task.id,
        type: DELIVERY_CONFLICT,
        actor: "system",
        payload: {
          runId: h.verify.id,
          reason: "tests_failed",
          baseBranch: "main",
          files: [],
          output: "x",
        },
      });
    }
    const first = await h.service.deliver(h.task.id);
    if (first.status !== "delivered") throw new Error(`entrega: ${first.status}`);

    // Another PR was merged and GitHub marks this one in conflict: the poller reopens the task.
    expect(new TaskPrRepository(h.db).recordPrConflict(h.task.id, first.prUrl)).toBe(true);
    expect(h.taskNow()).toMatchObject({ state: "in_progress", prState: "open" });

    // The implementer integrates the base and passes verification again; the final suite fails once:
    // it is the first conflict since the pass, not the fourth.
    setTaskPosition(h.db, h.task.id, { state: "verification", subState: "running" });
    h.testGate.result = { passed: false, output: "1 failed" };
    expect((await h.service.deliver(h.task.id)).status).toBe("conflict");

    setTaskPosition(h.db, h.task.id, { state: "verification", subState: "running" });
    h.testGate.result = { passed: true, output: "ok" };
    const again = await h.service.deliver(h.task.id);
    expect(again).toMatchObject({ status: "delivered", created: false, prUrl: first.prUrl });
    expect(h.github.created).toHaveLength(1);
    expect(h.taskNow()).toMatchObject({ state: "completed", prUrl: first.prUrl });
  });

  it("a blocked before_delivery hook stops the delivery before touching git", async () => {
    const h = deliveryHarness();
    await h.agentCommits();
    h.hooks.results.before_delivery = {
      outcome: "blocked",
      escalated: true,
      failedScript: "10-bump",
      error: "exit 1",
    };

    expect(await h.service.deliver(h.task.id)).toEqual({ status: "blocked" });
    expect(h.calls).toEqual(["hook:before_delivery"]);
    expect(h.github.created).toEqual([]);
    expect(h.closedRuns).toEqual([]);
  });

  it("a blocked hook that HookService did not escalate is escalated by the delivery", async () => {
    const h = deliveryHarness();
    h.hooks.results.before_delivery = {
      outcome: "blocked",
      escalated: false,
      failedScript: null,
      error: "lunasq/hooks/config inválido",
    };
    expect(await h.service.deliver(h.task.id)).toEqual({ status: "blocked" });
    expect(h.taskNow()).toMatchObject({ state: "needs_human" });
    expect(eventsOf(h, TASK_TRANSITIONED).at(-1)?.payload).toMatchObject({
      reason: "hook_failed",
    });
  });

  it("if the push fails, it escalates with delivery_failed and does not create the PR", async () => {
    const h = deliveryHarness();
    await h.agentCommits();
    h.git.push = async () => {
      throw new Error("remote rejected");
    };

    const result = await h.service.deliver(h.task.id);

    expect(result).toMatchObject({
      status: "escalated",
      error: expect.stringContaining("remote rejected"),
    });
    expect(h.taskNow()).toMatchObject({ state: "needs_human" });
    expect(eventsOf(h, TASK_TRANSITIONED).at(-1)?.payload).toMatchObject({
      command: "escalate",
      reason: "delivery_failed",
      note: expect.stringContaining("remote rejected"),
    });
    expect(h.github.created).toEqual([]);
  });

  it("if gh fails after the push, it escalates and the PR is not recorded", async () => {
    const h = deliveryHarness();
    await h.agentCommits();
    h.github.createPr = async () => {
      throw new Error("gh: not authenticated");
    };

    expect(await h.service.deliver(h.task.id)).toMatchObject({ status: "escalated" });
    expect(h.taskNow()).toMatchObject({ state: "needs_human", prUrl: null });
    // The verifier's Run is not left open with the task in needs_human.
    expect(new RunRepository(h.db).get(h.verify.id)?.endedAt).not.toBeNull();
  });

  it("a blocked after_delivery hook leaves the PR recorded and escalates without completing", async () => {
    const h = deliveryHarness();
    await h.agentCommits();
    h.hooks.results.after_delivery = {
      outcome: "blocked",
      escalated: true,
      failedScript: "10-notify",
      error: "exit 2",
    };

    expect(await h.service.deliver(h.task.id)).toEqual({ status: "blocked" });
    expect(h.taskNow()).toMatchObject({ prState: "open" });
    expect(h.taskNow()?.state).not.toBe("completed");
  });

  it("if after_delivery commits, it makes a second push so it enters the PR", async () => {
    const h = deliveryHarness();
    await h.agentCommits();
    h.hooks.onRun = (input) => {
      h.calls.push(`hook:${input.point}`);
      if (input.point === "after_delivery") {
        h.git.writeWorkingFile(WORKTREE, "CHANGELOG.md");
        void h.git.commitAll({
          cwd: WORKTREE,
          message: "chore(lunasq): hooks after_delivery",
          trailers: {},
        });
      }
    };

    expect((await h.service.deliver(h.task.id)).status).toBe("delivered");

    expect(h.calls.filter((c) => c === "push")).toHaveLength(2);
    expect(h.calls.indexOf("hook:after_delivery")).toBeLessThan(h.calls.lastIndexOf("push"));
    expect(h.git.remoteBranch(WORKTREE, BRANCH)).toBe(
      await h.git.resolveCommit({ cwd: WORKTREE, ref: "HEAD" }),
    );
    expect(h.taskNow()).toMatchObject({ state: "completed" });
  });

  it("if after_delivery does not commit, it does not push again", async () => {
    const h = deliveryHarness();
    await h.agentCommits();
    await h.service.deliver(h.task.id);
    expect(h.calls.filter((c) => c === "push")).toHaveLength(1);
  });

  it("without a verifier pass, or with the task outside verification/running, it does nothing", async () => {
    const reject = deliveryHarness({ verdict: "verification-reject" });
    expect(await reject.service.deliver(reject.task.id)).toEqual({
      status: "skipped",
      reason: "no_pass_verdict",
    });
    const moved = deliveryHarness({ position: { state: "in_progress", subState: "queued" } });
    expect(await moved.service.deliver(moved.task.id)).toEqual({
      status: "skipped",
      reason: "not_delivering",
    });
    expect(await moved.service.deliver("00000000-0000-4000-8000-000000000000")).toEqual({
      status: "skipped",
      reason: "task_not_found",
    });
    expect(moved.calls).toEqual([]);
  });

  it("without EvidenceService the delivery continues", async () => {
    const h = deliveryHarness({ without: { evidence: true } });
    await h.agentCommits();
    expect((await h.service.deliver(h.task.id)).status).toBe("delivered");
  });

  it("two simultaneous deliveries of the same task open a single PR", async () => {
    const h = deliveryHarness();
    await h.agentCommits();
    const [a, b] = await Promise.all([h.service.deliver(h.task.id), h.service.deliver(h.task.id)]);
    expect([a.status, b.status].sort()).toEqual(["delivered", "skipped"]);
    expect(h.github.created).toHaveLength(1);
  });
});

describe("DeliveryService.recover", () => {
  it("resumes the tasks in verification/running with a saved pass", async () => {
    const h = deliveryHarness();
    await h.agentCommits();
    const results = await h.service.recover();
    expect(results).toMatchObject([{ status: "delivered" }]);
    expect(h.taskNow()).toMatchObject({ state: "completed" });
  });

  it("leaves an ongoing verification (without a saved pass) alone", async () => {
    const h = deliveryHarness({ verdict: "verification-reject" });
    expect(await h.service.recover()).toEqual([]);
    expect(h.taskNow()).toMatchObject({ state: "verification" });
  });
});

describe("subscribeDelivery", () => {
  it("a registered pass starts the delivery through the outbox; a reject does not", async () => {
    const h = deliveryHarness();
    await h.agentCommits();
    const publisher = new OutboxPublisher({ db: h.db });
    const delivered: string[] = [];
    const unsubscribe = subscribeDelivery({
      publisher,
      delivery: {
        deliver: async (taskId) => {
          delivered.push(taskId);
          return h.service.deliver(taskId);
        },
      },
    });
    await publisher.drain();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(delivered).toEqual([h.task.id]);

    const other = deliveryHarness({ verdict: "verification-reject" });
    const rejectPublisher = new OutboxPublisher({ db: other.db });
    subscribeDelivery({
      publisher: rejectPublisher,
      delivery: { deliver: async (taskId) => void delivered.push(taskId) as never },
    });
    await rejectPublisher.drain();
    expect(delivered).toEqual([h.task.id]);
    unsubscribe();
  });

  it("an error of the delivery is reported and does not break the publisher", async () => {
    const h = deliveryHarness();
    const publisher = new OutboxPublisher({ db: h.db });
    const errors: string[] = [];
    subscribeDelivery({
      publisher,
      delivery: {
        deliver: async () => {
          throw new Error("boom");
        },
      },
      onError: (error, taskId) => errors.push(`${taskId}:${error.message}`),
    });
    await publisher.drain();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(errors).toEqual([`${h.task.id}:boom`]);
  });
});

void FakeGit;
void TaskRepository;
