import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FakeApi, SPEC_CONTENT } from "../../test/fake-api.ts";
import { renderApp } from "../../test/render.tsx";

function seeded() {
  const fake = new FakeApi();
  const project = fake.addProject({ name: "lunas-queue" });
  const dep = fake.addTask(project.id, { intent: "Esquema de usuarios" });
  const task = fake.addTask(project.id, {
    intent: "Login con email",
    tags: ["auth"],
    priority: 200,
    worktreePath: "/w/login",
    branch: "lunasq/login",
  });
  fake.edges.push({ taskId: task.id, dependsOnId: dep.id });
  return { fake, project, dep, task };
}

const section = async (name: string) => within(await screen.findByRole("region", { name }));

describe("detalle de tarea", () => {
  it("muestra cabecera, dependencias y estado", async () => {
    const { fake, task, dep } = seeded();
    fake.transition(task.id, "refined", null);
    renderApp(`/tasks/${task.id}`, fake);

    expect(await screen.findByRole("heading", { name: "Login con email" })).toBeTruthy();
    expect(screen.getByText("Refined")).toBeTruthy();
    expect(screen.getByText("lunasq/login")).toBeTruthy();
    expect(await screen.findByRole("link", { name: "lunas-queue" })).toBeTruthy();
    expect(
      await (await section("Dependencias")).findByRole("link", { name: dep.intent }),
    ).toBeTruthy();
  });

  it("lista los Runs con resultado, failure_reason, pane y handoff", async () => {
    const { fake, task } = seeded();
    const failed = fake.startRun(task.id, "refine");
    fake.endRun(failed.id, { result: "failure", failureReason: "timeout de fase (60 min)" });
    const ok = fake.startRun(task.id, "refine");
    fake.endRun(ok.id, { handoff: { phase: "refinement", summary: "spec lista" } });
    renderApp(`/tasks/${task.id}`, fake);

    const runs = await section("Runs");
    const rows = await runs.findAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(within(rows[1] as HTMLElement).getByText("fallo")).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText("timeout de fase (60 min)")).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText("éxito")).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText(/"summary": "spec lista"/)).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText(failed.herdrPane as string)).toBeTruthy();
  });

  it("muestra el Event log con actor y transición", async () => {
    const { fake, task } = seeded();
    fake.transition(task.id, "refined", null);
    renderApp(`/tasks/${task.id}`, fake);
    const log = await section("Event log");
    expect(await log.findByText("task.created")).toBeTruthy();
    expect(log.getByText("Draft · en cola → Refined")).toBeTruthy();
    expect(log.getAllByText("system")).toHaveLength(1);
  });

  it("muestra el usage total y por Run", async () => {
    const { fake, task } = seeded();
    const run = fake.startRun(task.id, "implement");
    const usage = {
      inputTokens: 300,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheWriteTokens: 0,
      costUsd: 0.25,
    };
    fake.usage.set(task.id, {
      total: usage,
      byRun: [{ runId: run.id, phase: "implement", usage }],
      byPhase: [{ phase: "implement", usage }],
      byAgent: [{ agentKind: "claude", usage }],
      byModel: [{ model: "opus", usage }],
      byReviewer: [],
    });
    renderApp(`/tasks/${task.id}`, fake);
    const block = await section("Usage");
    expect(await block.findByText("360 tokens · $0.25")).toBeTruthy();
    expect(block.getByText("Implementación")).toBeTruthy();
  });

  it("renderiza el archivo de evidencia", async () => {
    const { fake, task } = seeded();
    fake.evidence.set(task.id, "# Evidencia\n\n## Run 1\n\nTodo **verde**.");
    renderApp(`/tasks/${task.id}`, fake);
    const block = await section("Evidencia");
    expect(await block.findByRole("heading", { name: "Run 1" })).toBeTruthy();
    expect(block.getByText("verde").tagName).toBe("STRONG");
    expect(block.getByText(`/w/login/lunasq/tasks/${task.id}.md`)).toBeTruthy();
  });

  it("avisa cuando aún no hay archivo de evidencia", async () => {
    const { fake, task } = seeded();
    renderApp(`/tasks/${task.id}`, fake);
    expect(await screen.findByText("Todavía no hay archivo de evidencia.")).toBeTruthy();
  });

  it("indica de dónde salió la evidencia cuando ya no hay worktree", async () => {
    const { fake, task } = seeded();
    fake.evidence.set(task.id, "# Evidencia");
    fake.evidenceSource.set(task.id, "branch");
    renderApp(`/tasks/${task.id}`, fake);
    const block = await section("Evidencia");
    expect(await block.findByText(`origin/lunasq/login:lunasq/tasks/${task.id}.md`)).toBeTruthy();
    expect(block.getByText(/Desde branch de la tarea/)).toBeTruthy();
  });

  it("muestra las versiones de la spec, su contenido y el diff contra la anterior", async () => {
    const { fake, task } = seeded();
    fake.addSpec(task.id);
    fake.addSpec(task.id, {
      ...SPEC_CONTENT,
      criteria: [
        ...SPEC_CONTENT.criteria,
        { id: "AC-2", given: "contraseña errónea", when: "inicia sesión", outcome: "ve un error" },
      ],
    });
    const { user } = renderApp(`/tasks/${task.id}`, fake);

    const spec = await section("Spec");
    expect(await spec.findByRole("button", { name: "v2" })).toHaveProperty("ariaPressed", "true");
    expect(spec.getByText(/AC-2/)).toBeTruthy();
    expect(spec.getByText("El usuario inicia sesión con email")).toBeTruthy();
    expect(await spec.findByText("Cambios contra v1")).toBeTruthy();

    await user.click(spec.getByRole("button", { name: "v1" }));
    await waitFor(() => expect(spec.queryByText(/AC-2/)).toBeNull());
    expect(await spec.findByText("Primera versión")).toBeTruthy();
  });

  it("aprueba la versión pendiente de una tarea refined", async () => {
    const { fake, task } = seeded();
    fake.transition(task.id, "refined", null);
    fake.addSpec(task.id);
    const { user } = renderApp(`/tasks/${task.id}`, fake);

    await user.click(await (await section("Spec")).findByRole("button", { name: "Aprobar v1" }));
    expect(await screen.findByText("In progress")).toBeTruthy();
    expect(fake.requests.some((r) => r.path === `/api/tasks/${task.id}/specs/1/approve`)).toBe(
      true,
    );
    expect((await section("Spec")).queryByRole("button", { name: "Aprobar v1" })).toBeNull();
  });

  it("muestra el 409 del servidor si la spec ya no está pendiente", async () => {
    const { fake, task } = seeded();
    fake.transition(task.id, "refined", null);
    const spec = fake.addSpec(task.id);
    const { user } = renderApp(`/tasks/${task.id}`, fake);
    const approve = await (await section("Spec")).findByRole("button", { name: "Aprobar v1" });
    spec.approval = "approved";
    await user.click(approve);
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "la versión 1 ya está en approved",
    );
  });

  it("muestra la versión nueva cuando llega mientras se revisaba una anterior", async () => {
    const { fake, task } = seeded();
    fake.transition(task.id, "refined", null);
    fake.addSpec(task.id);
    fake.addSpec(task.id);
    const { user, refresh } = renderApp(`/tasks/${task.id}`, fake);
    const spec = await section("Spec");
    await user.click(await spec.findByRole("button", { name: "v1" }));
    fake.addSpec(task.id);
    await refresh();
    expect(await spec.findByRole("button", { name: "Aprobar v3" })).toBeTruthy();
  });

  it("pide cambios con comentarios", async () => {
    const { fake, task } = seeded();
    fake.transition(task.id, "refined", null);
    fake.addSpec(task.id);
    const { user } = renderApp(`/tasks/${task.id}`, fake);

    const spec = await section("Spec");
    await user.type(await spec.findByLabelText("Comentarios"), "Falta el caso de bloqueo");
    await user.click(spec.getByRole("button", { name: "Pedir cambios" }));
    expect(await spec.findByText("Comentarios de revisión: Falta el caso de bloqueo")).toBeTruthy();
    expect(fake.requests.find((r) => r.path.endsWith("/request-changes"))?.body).toEqual({
      comments: "Falta el caso de bloqueo",
    });
  });

  it("cancela la tarea tras confirmar", async () => {
    const { fake, task } = seeded();
    const { user } = renderApp(`/tasks/${task.id}`, fake);
    await user.click(await screen.findByRole("button", { name: "Cancelar tarea" }));
    await user.click(screen.getByRole("button", { name: "Sí, cancelar" }));
    expect(await screen.findByText("Cancelled")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancelar tarea" })).toBeNull();
  });

  it("avisa si la tarea no existe", async () => {
    renderApp("/tasks/00000000-0000-4000-8000-000000000999");
    expect(await screen.findByText("La tarea no existe.")).toBeTruthy();
  });
});

describe("menciones #N en el intent del detalle", () => {
  it("una mención a una tarea existente es un enlace a su detalle", async () => {
    const { fake, project, dep } = seeded();
    const task = fake.addTask(project.id, { intent: `Depende de #${dep.number} para arrancar` });
    renderApp(`/tasks/${task.id}`, fake);

    const heading = await screen.findByRole("heading", {
      name: `Depende de #${dep.number} para arrancar`,
    });
    const link = await within(heading).findByRole("link", { name: `#${dep.number}` });
    expect(link).toHaveProperty("href", expect.stringContaining(`/tasks/${dep.id}`));
  });

  it("un número inexistente, #abc o a#5 se muestran tal cual, sin enlace", async () => {
    const { fake, project, dep } = seeded();
    // La última mención sí existe: cuando es enlace, las tareas ya cargaron.
    const intent = `Ver #999, #abc, a#${dep.number} y #${dep.number}`;
    const task = fake.addTask(project.id, { intent });
    renderApp(`/tasks/${task.id}`, fake);

    const heading = await screen.findByRole("heading", { name: intent });
    await within(heading).findByRole("link", { name: `#${dep.number}` });
    expect(within(heading).getAllByRole("link")).toHaveLength(1);
  });
});

describe("menciones #N en tarjetas y filas que ya son enlace", () => {
  it("el tablero y la cola muestran el intent como texto plano, sin enlaces anidados", async () => {
    const { fake, project, dep } = seeded();
    const intent = `Depende de #${dep.number}`;
    const task = fake.addTask(project.id, { intent });
    fake.queue = [
      {
        task,
        ready: true,
        score: 1,
        effectivePriority: 1,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: null,
        },
      },
    ];
    const board = renderApp(`/projects/${project.id}`, fake);
    const card = await screen.findByRole("link", { name: intent });
    expect(card.querySelector("a")).toBeNull();
    board.unmount();

    renderApp("/queue", fake);
    const row = await screen.findByRole("link", { name: intent });
    expect(row.querySelector("a")).toBeNull();
  });
});
