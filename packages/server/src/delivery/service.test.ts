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
  it("una tarea con pass termina en un PR con trailers y etiqueta de riesgo", async () => {
    const h = deliveryHarness();
    await h.agentCommits();
    h.baseMoves({ "CHANGELOG.md": { content: "v2\n" } });

    const result = await h.service.deliver(h.task.id);

    expect(result).toMatchObject({ status: "delivered", created: true });
    // Orden de la entrega: hook, evidencia pendiente, rebase, trailers, suite final, cierre del
    // Run y evidencia, push, PR con su etiqueta y after_delivery.
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

    // El branch publicado lleva los commits del agente con los trailers de la tarea y su Run.
    const commits = await h.git.listCommits({ cwd: WORKTREE, base: "origin/main" });
    expect(commits).toHaveLength(2);
    for (const commit of commits) {
      expect(commit.message).toContain(`LunasQ-Task: ${h.task.id}`);
      expect(commit.message).toContain(`LunasQ-Run: ${h.implement.id}`);
    }
    expect(h.git.remoteBranch(WORKTREE, BRANCH)).toBe(
      await h.git.resolveCommit({ cwd: WORKTREE, ref: "HEAD" }),
    );

    // El PR trae intent, criterios, evidencia, riesgo y trailers, y su etiqueta.
    const [input] = h.github.created;
    expect(input).toMatchObject({ cwd: WORKTREE, head: BRANCH, base: "main" });
    expect(input?.title).toBe("Permitir cancelar pedidos pendientes");
    expect(input?.body).toContain("Permitir cancelar pedidos pendientes");
    expect(input?.body).toContain("AC-1");
    expect(input?.body).toContain("Riesgo: **bajo**");
    expect(input?.body).toContain(`LunasQ-Task: ${h.task.id}`);
    expect(input?.body).toContain(`LunasQ-Run: ${h.verify.id}`);
    expect(result.status === "delivered" && (await h.github.getPr(result.prUrl)).labels).toEqual([
      "lunasq:risk-low",
    ]);

    // La tarea queda completada con su PR abierto registrado y el Run del verificador cerrado.
    expect(h.taskNow()).toMatchObject({ state: "completed", prState: "open" });
    expect(h.taskNow()?.prUrl).toBe(result.status === "delivered" ? result.prUrl : "");
    expect(eventsOf(h, TASK_PR_OPENED)).toHaveLength(1);
    expect(h.closedRuns).toEqual([h.verify.id]);
    expect(new RunRepository(h.db).get(h.verify.id)).toMatchObject({ result: "success" });
    // Se commitea antes del rebase y otra vez tras cerrar el Run del verificador (idempotente).
    expect(h.evidenceCommits).toEqual([h.task.id, h.task.id]);
    expect(h.hooks.calls.at(-1)).toMatchObject({
      point: "after_delivery",
      runId: h.verify.id,
      prUrl: result.status === "delivered" ? result.prUrl : "",
    });
  });

  it("repetirla con la tarea ya completada no crea otro PR", async () => {
    const h = deliveryHarness();
    await h.agentCommits();
    await h.service.deliver(h.task.id);
    const again = await h.service.deliver(h.task.id);
    expect(again).toEqual({ status: "skipped", reason: "not_delivering" });
    expect(h.github.created).toHaveLength(1);
  });

  it("retomada tras una caída (Run ya cerrado, PR ya creado) completa con el mismo PR", async () => {
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
    // El Run ya estaba cerrado: no se vuelve a cerrar.
    expect(h.closedRuns).toEqual([]);
  });

  it("sin comando de tests no hay gate en verde: la entrega se detiene", async () => {
    const h = deliveryHarness({ testCommand: null });
    await h.agentCommits();
    h.testGate.result = { passed: false, output: "el proyecto no tiene comando de tests" };
    const result = await h.service.deliver(h.task.id);
    expect(result).toMatchObject({ status: "conflict", reason: "tests_failed" });
    expect(h.git.remoteBranch(WORKTREE, BRANCH)).toBeNull();
  });

  it("un conflicto al integrar la base regresa la tarea a in_progress sin subir la iteración", async () => {
    const h = deliveryHarness();
    // Mismo archivo que cambió la base.
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
    // Sin suite, push ni PR; el Run del verificador se cerró con éxito para dejar su evidencia.
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

  it("la suite en rojo tras el rebase también regresa la tarea, con la cola de la salida", async () => {
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

  it("tras tantos conflictos como iteraciones de verificación, escala a needs_human", async () => {
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
    // Con 2 conflictos previos y tope 3, el tercero todavía regresa a implementación...
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
    // ...y el cuarto no.
    const result = await second.service.deliver(second.task.id);
    expect(result).toMatchObject({ status: "escalated" });
    expect(second.taskNow()).toMatchObject({ state: "needs_human" });
    const escalation = eventsOf(second, TASK_TRANSITIONED).at(-1)?.payload;
    expect(escalation).toMatchObject({ command: "escalate", reason: "delivery_failed" });
  });

  it("un PR entregado que queda en conflicto se entrega de nuevo sobre el mismo PR, con el conteo de conflictos desde cero", async () => {
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

    // Otro PR se mergeó y GitHub marca este en conflicto: el poller reabre la tarea.
    expect(new TaskPrRepository(h.db).recordPrConflict(h.task.id, first.prUrl)).toBe(true);
    expect(h.taskNow()).toMatchObject({ state: "in_progress", prState: "open" });

    // El implementador integra la base y vuelve a pasar la verificación; la suite final falla una
    // vez: es el primer conflicto desde el pass, no el cuarto.
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

  it("un hook before_delivery bloqueado detiene la entrega antes de tocar git", async () => {
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

  it("un hook bloqueado que HookService no escaló lo escala la entrega", async () => {
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

  it("si el push falla, escala con delivery_failed y no crea el PR", async () => {
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

  it("si gh falla después del push, escala y el PR no queda registrado", async () => {
    const h = deliveryHarness();
    await h.agentCommits();
    h.github.createPr = async () => {
      throw new Error("gh: not authenticated");
    };

    expect(await h.service.deliver(h.task.id)).toMatchObject({ status: "escalated" });
    expect(h.taskNow()).toMatchObject({ state: "needs_human", prUrl: null });
    // El Run del verificador no queda abierto con la tarea en needs_human.
    expect(new RunRepository(h.db).get(h.verify.id)?.endedAt).not.toBeNull();
  });

  it("un hook after_delivery bloqueado deja el PR registrado y escala sin completar", async () => {
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

  it("si after_delivery commitea, hace un segundo push para que entre al PR", async () => {
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

  it("si after_delivery no commitea, no vuelve a hacer push", async () => {
    const h = deliveryHarness();
    await h.agentCommits();
    await h.service.deliver(h.task.id);
    expect(h.calls.filter((c) => c === "push")).toHaveLength(1);
  });

  it("sin pass del verificador, o con la tarea fuera de verification/running, no hace nada", async () => {
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

  it("sin EvidenceService la entrega sigue", async () => {
    const h = deliveryHarness({ without: { evidence: true } });
    await h.agentCommits();
    expect((await h.service.deliver(h.task.id)).status).toBe("delivered");
  });

  it("dos entregas simultáneas de la misma tarea abren un solo PR", async () => {
    const h = deliveryHarness();
    await h.agentCommits();
    const [a, b] = await Promise.all([h.service.deliver(h.task.id), h.service.deliver(h.task.id)]);
    expect([a.status, b.status].sort()).toEqual(["delivered", "skipped"]);
    expect(h.github.created).toHaveLength(1);
  });
});

describe("DeliveryService.recover", () => {
  it("retoma las tareas en verification/running con un pass guardado", async () => {
    const h = deliveryHarness();
    await h.agentCommits();
    const results = await h.service.recover();
    expect(results).toMatchObject([{ status: "delivered" }]);
    expect(h.taskNow()).toMatchObject({ state: "completed" });
  });

  it("deja en paz una verificación en curso (sin pass guardado)", async () => {
    const h = deliveryHarness({ verdict: "verification-reject" });
    expect(await h.service.recover()).toEqual([]);
    expect(h.taskNow()).toMatchObject({ state: "verification" });
  });
});

describe("subscribeDelivery", () => {
  it("un pass registrado arranca la entrega por el outbox; un reject no", async () => {
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

  it("un error de la entrega se reporta y no rompe al publicador", async () => {
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
