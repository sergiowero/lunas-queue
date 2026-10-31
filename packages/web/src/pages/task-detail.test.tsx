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

  it("con título lo muestra como encabezado y deja el intent debajo", async () => {
    const { fake, task } = seeded();
    task.title = "Login por correo";
    renderApp(`/tasks/${task.id}`, fake);

    expect(await screen.findByRole("heading", { name: "Login por correo" })).toBeTruthy();
    expect(screen.getByText("Login con email")).toBeTruthy();
  });

  it("una tarea In progress muestra su etiqueta de estado en azul", async () => {
    const { fake, task } = seeded();
    fake.transition(task.id, "in_progress", "running");
    renderApp(`/tasks/${task.id}`, fake);

    await screen.findByRole("heading", { name: "Login con email" });
    expect(screen.getByText("In progress").dataset.variant).toBe("info");
    expect(screen.getByText("corriendo")).toBeTruthy();
  });

  it("agrega y quita dependencias mientras la tarea está en draft", async () => {
    const { fake, project, task, dep } = seeded();
    const other = fake.addProject({ name: "api" });
    const extra = fake.addTask(other.id, { intent: "Endpoint de login" });
    fake.addTask(project.id, { intent: "Ya cancelada", state: "cancelled", subState: null });
    const { user } = renderApp(`/tasks/${task.id}`, fake);

    const deps = await section("Dependencias");
    const select = await deps.findByLabelText("Agregar dependencia");
    // Las opciones llevan el #N delante («#N · intent»): se busca por el final del nombre.
    expect(select.querySelectorAll("option")).toHaveLength(2);
    expect(deps.queryByRole("option", { name: new RegExp(`· ${dep.intent}$`) })).toBeNull();
    expect(deps.queryByRole("option", { name: /· Ya cancelada$/ })).toBeNull();
    expect(deps.queryByRole("option", { name: new RegExp(`· ${task.intent}$`) })).toBeNull();
    expect(deps.getByRole("option", { name: new RegExp(`· ${extra.intent}$`) })).toBeTruthy();
    await user.selectOptions(select, extra.id);
    await user.click(deps.getByRole("button", { name: "Agregar" }));

    expect(await deps.findByRole("link", { name: extra.intent })).toBeTruthy();
    expect(deps.getByText("otro proyecto")).toBeTruthy();
    expect(fake.edges).toContainEqual({ taskId: task.id, dependsOnId: extra.id });

    await user.click(deps.getByRole("button", { name: `Quitar dependencia ${dep.intent}` }));
    await waitFor(() => expect(deps.queryByRole("link", { name: dep.intent })).toBeNull());
    expect(fake.edges).toEqual([{ taskId: task.id, dependsOnId: extra.id }]);
  });

  it("muestra el error del servidor si la dependencia cierra un ciclo", async () => {
    const { fake, task, dep } = seeded();
    const { user } = renderApp(`/tasks/${dep.id}`, fake);

    const deps = await section("Dependencias");
    await user.selectOptions(await deps.findByLabelText("Agregar dependencia"), task.id);
    await user.click(deps.getByRole("button", { name: "Agregar" }));
    expect((await deps.findByRole("alert")).textContent).toContain("ciclo");
    expect(fake.edges).toHaveLength(1);
  });

  it("no ofrece editar dependencias fuera de draft", async () => {
    const { fake, task } = seeded();
    fake.transition(task.id, "refined", null);
    renderApp(`/tasks/${task.id}`, fake);

    const deps = await section("Dependencias");
    await deps.findByText("Depende de");
    expect(deps.queryByLabelText("Agregar dependencia")).toBeNull();
    expect(deps.queryByRole("button", { name: /Quitar dependencia/ })).toBeNull();
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

  it("el Event log va colapsado por default", async () => {
    const { fake, task } = seeded();
    renderApp(`/tasks/${task.id}`, fake);
    const log = await section("Event log");
    const details = (await log.findByText(/Mostrar \d+ eventos?/)).closest("details");
    expect(details?.open).toBe(false);
  });

  it("muestra consumo registrado y explica que el usage de Copilot no está disponible", async () => {
    const { fake, task } = seeded();
    const run = fake.startRun(task.id, "implement");
    const copilotRun = fake.startRun(task.id, "verify");
    copilotRun.agentKind = "copilot";
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
    expect(
      await block.findByText(/Consumo registrado \(parcial: Copilot CLI no informa usage\)/),
    ).toBeTruthy();
    expect(block.getByText(/360 tokens · \$0\.25/)).toBeTruthy();
    expect(block.getByText("Implementación")).toBeTruthy();
    expect(block.getAllByText("No disponible")).toHaveLength(4);
  });

  it("el panel Evidencia nace colapsado y no muestra la evidencia", async () => {
    const { fake, task } = seeded();
    fake.evidence.set(task.id, "# Evidencia\n\n## Run 1\n\nTodo **verde**.");
    renderApp(`/tasks/${task.id}`, fake);
    const block = await section("Evidencia");
    const toggle = await block.findByRole("button", { name: "Mostrar evidencia" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(block.queryByRole("heading", { name: "Run 1" })).toBeNull();
    expect(block.queryByText(`/w/login/lunasq/tasks/${task.id}.md`)).toBeNull();
  });

  it("expandir el panel Evidencia muestra origen, ruta y markdown", async () => {
    const { fake, task } = seeded();
    fake.evidence.set(task.id, "# Evidencia\n\n## Run 1\n\nTodo **verde**.");
    const { user } = renderApp(`/tasks/${task.id}`, fake);
    const block = await section("Evidencia");
    await user.click(await block.findByRole("button", { name: "Mostrar evidencia" }));
    expect(await block.findByRole("heading", { name: "Run 1" })).toBeTruthy();
    expect(block.getByText("verde").tagName).toBe("STRONG");
    expect(block.getByText(/Desde worktree/)).toBeTruthy();
    expect(block.getByText(`/w/login/lunasq/tasks/${task.id}.md`)).toBeTruthy();
  });

  it("colapsar de nuevo el panel Evidencia oculta la evidencia", async () => {
    const { fake, task } = seeded();
    fake.evidence.set(task.id, "# Evidencia\n\n## Run 1\n\nTodo **verde**.");
    const { user } = renderApp(`/tasks/${task.id}`, fake);
    const block = await section("Evidencia");
    const toggle = await block.findByRole("button", { name: "Mostrar evidencia" });
    await user.click(toggle);
    expect(await block.findByRole("heading", { name: "Run 1" })).toBeTruthy();
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(block.queryByRole("heading", { name: "Run 1" })).toBeNull();
    expect(screen.getByRole("region", { name: "Evidencia" })).toBeTruthy();
  });

  it("el panel Evidencia se expande con el teclado", async () => {
    const { fake, task } = seeded();
    fake.evidence.set(task.id, "# Evidencia\n\n## Run 1");
    const { user } = renderApp(`/tasks/${task.id}`, fake);
    const block = await section("Evidencia");
    const toggle = await block.findByRole("button", { name: "Mostrar evidencia" });
    toggle.focus();
    await user.keyboard("{Enter}");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(await block.findByRole("heading", { name: "Run 1" })).toBeTruthy();
  });

  it("el panel Evidencia nace colapsado al volver a una tarea ya visitada", async () => {
    const { fake, task, dep } = seeded();
    fake.evidence.set(task.id, "# Evidencia\n\n## Run 1");
    fake.evidence.set(dep.id, "# Evidencia\n\n## Run 2");
    const { user, router } = renderApp(`/tasks/${task.id}`, fake);
    const toggleOf = async () =>
      (await section("Evidencia")).findByRole("button", { name: "Mostrar evidencia" });

    await toggleOf();
    await router.navigate({ to: "/tasks/$taskId", params: { taskId: dep.id } });
    const depToggle = await toggleOf();
    await user.click(depToggle);
    expect(depToggle.getAttribute("aria-expanded")).toBe("true");

    await router.navigate({ to: "/tasks/$taskId", params: { taskId: task.id } });
    await waitFor(async () =>
      expect(screen.getByRole("heading", { name: "Login con email" })).toBeTruthy(),
    );
    expect((await toggleOf()).getAttribute("aria-expanded")).toBe("false");

    await router.navigate({ to: "/tasks/$taskId", params: { taskId: dep.id } });
    await waitFor(async () =>
      expect(screen.getByRole("heading", { name: "Esquema de usuarios" })).toBeTruthy(),
    );
    expect((await toggleOf()).getAttribute("aria-expanded")).toBe("false");
  });

  it("avisa cuando aún no hay archivo de evidencia al expandir el panel", async () => {
    const { fake, task } = seeded();
    const { user } = renderApp(`/tasks/${task.id}`, fake);
    const block = await section("Evidencia");
    const toggle = await block.findByRole("button", { name: "Mostrar evidencia" });
    expect(block.queryByText("Todavía no hay archivo de evidencia.")).toBeNull();
    await user.click(toggle);
    expect(await block.findByText("Todavía no hay archivo de evidencia.")).toBeTruthy();
    await user.click(toggle);
    expect(block.queryByText("Todavía no hay archivo de evidencia.")).toBeNull();
  });

  it("indica de dónde salió la evidencia cuando ya no hay worktree", async () => {
    const { fake, task } = seeded();
    fake.evidence.set(task.id, "# Evidencia");
    fake.evidenceSource.set(task.id, "branch");
    const { user } = renderApp(`/tasks/${task.id}`, fake);
    const block = await section("Evidencia");
    await user.click(await block.findByRole("button", { name: "Mostrar evidencia" }));
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

  it("reanuda una tarea en needs_human hacia el estado desde el que se escaló", async () => {
    const { fake, task } = seeded();
    fake.transition(task.id, "needs_human", null);
    const { user } = renderApp(`/tasks/${task.id}`, fake);
    await user.click(await screen.findByRole("button", { name: "Reanudar tarea" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Reanudar tarea" })).toBeNull(),
    );
    expect(fake.task(task.id).state).toBe("draft");
    expect(screen.getByRole("button", { name: "Cancelar tarea" })).toBeTruthy();
  });

  it("no ofrece reanudar fuera de needs_human", async () => {
    const { fake, task } = seeded();
    renderApp(`/tasks/${task.id}`, fake);
    await screen.findByRole("button", { name: "Cancelar tarea" });
    expect(screen.queryByRole("button", { name: "Reanudar tarea" })).toBeNull();
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
