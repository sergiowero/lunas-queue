import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FakeApi } from "../../test/fake-api.ts";
import { renderApp } from "../../test/render.tsx";
import { BLOCKED_REFRESH_MS, queries } from "../lib/queries.ts";

function seeded() {
  const fake = new FakeApi();
  const project = fake.addProject({ name: "lunas-queue" });
  return { fake, project };
}

const section = async (name: string) => within(await screen.findByRole("region", { name }));
/** Pendiente dentro de su sección: una tarea puede aparecer en más de una. */
const item = async (sectionName: string, name: string) =>
  within(await (await section(sectionName)).findByRole("article", { name }));
/** Fila de la lista de specs: la tarea en refined con su enlace. */
const specRow = async (name: string) => {
  const specs = await section("Specs por aprobar");
  const link = await specs.findByRole("link", { name });
  return within(link.closest("li") as HTMLElement);
};

describe("bandeja", () => {
  it("sin nada pendiente lo dice en cada sección", async () => {
    const { fake } = seeded();
    renderApp("/inbox", fake);
    expect(await screen.findByText("Nada espera por ti.")).toBeTruthy();
    expect(
      await (await section("Specs por aprobar")).findByText("Ninguna spec espera aprobación."),
    ).toBeTruthy();
    expect(
      await (await section("Tareas que necesitan atención")).findByText(
        "Ninguna tarea necesita atención.",
      ),
    ).toBeTruthy();
    expect(
      await (await section("Preguntas abiertas")).findByText("Ningún agente espera una respuesta."),
    ).toBeTruthy();
    expect(
      await (await section("Agentes bloqueados")).findByText("Ningún agente espera un permiso."),
    ).toBeTruthy();
  });

  it("lista la spec por aprobar como enlace a la tarea con su proyecto", async () => {
    const { fake, project } = seeded();
    const task = fake.addTask(project.id, { intent: "Login con email" });
    fake.addSpec(task.id);
    fake.transition(task.id, "refined", null);
    renderApp("/inbox", fake);

    const row = await specRow("Login con email");
    expect(row.getByRole("link", { name: "Login con email" }).getAttribute("href")).toBe(
      `/tasks/${task.id}`,
    );
    expect(await row.findByText("lunas-queue")).toBeTruthy();
  });

  it("la lista de specs no muestra la spec ni su gate", async () => {
    const { fake, project } = seeded();
    const task = fake.addTask(project.id, { intent: "Login con email" });
    fake.addSpec(task.id);
    fake.transition(task.id, "refined", null);
    renderApp("/inbox", fake);

    await specRow("Login con email");
    const specs = await section("Specs por aprobar");
    // Lo que el detalle muestra en cuanto carga la spec; aquí nunca debe aparecer.
    await expect(specs.findByText(/AC-1: dado un usuario/, {}, { timeout: 200 })).rejects.toThrow();
    expect(specs.queryByText("Primera versión")).toBeNull();
    expect(specs.queryByRole("button", { name: "v1" })).toBeNull();
    expect(specs.queryByRole("button", { name: "Aprobar v1" })).toBeNull();
    expect(specs.queryByRole("button", { name: "Pedir cambios" })).toBeNull();
    expect(specs.queryByRole("button", { name: "Editar y aprobar" })).toBeNull();
    expect(specs.queryByLabelText("Comentarios")).toBeNull();
    expect(fake.requests.some((r) => r.path.includes("/specs"))).toBe(false);
  });

  it("cada tarea en refined aparece una sola vez en la lista de specs", async () => {
    const { fake, project } = seeded();
    for (const intent of ["Login con email", "Logout", "Reset de contraseña"]) {
      const task = fake.addTask(project.id, { intent });
      fake.addSpec(task.id);
      fake.addSpec(task.id);
      fake.transition(task.id, "refined", null);
    }
    renderApp("/inbox", fake);

    const specs = await section("Specs por aprobar");
    const rows = await specs.findAllByRole("listitem");
    expect(rows.map((r) => within(r).getByRole("link").textContent)).toEqual([
      "Login con email",
      "Logout",
      "Reset de contraseña",
    ]);
  });

  it("el enlace de la spec lleva al detalle de la tarea con su gate", async () => {
    const { fake, project } = seeded();
    const task = fake.addTask(project.id, { intent: "Login con email" });
    fake.addSpec(task.id);
    fake.transition(task.id, "refined", null);
    const { user, router } = renderApp("/inbox", fake);

    await user.click((await specRow("Login con email")).getByRole("link"));

    await waitFor(() => expect(router.state.location.pathname).toBe(`/tasks/${task.id}`));
    expect(await screen.findByRole("heading", { name: "Login con email" })).toBeTruthy();
    const spec = await section("Spec");
    expect(await spec.findByText(/AC-1: dado un usuario/)).toBeTruthy();
    expect(await spec.findByRole("button", { name: "Aprobar v1" })).toBeTruthy();
  });

  it("lista la tarea en needs_human y la cuenta en el menú", async () => {
    const { fake, project } = seeded();
    const task = fake.addTask(project.id, { intent: "Migrar a Postgres" });
    fake.transition(task.id, "needs_human", null);
    renderApp("/inbox", fake);

    const escalated = await item("Tareas que necesitan atención", "Migrar a Postgres");
    expect(escalated.getByRole("link", { name: "Migrar a Postgres" })).toBeTruthy();
    expect(await escalated.findByText("Needs human")).toBeTruthy();
    expect(await screen.findByRole("link", { name: "Bandeja, 1 pendientes" })).toBeTruthy();
    expect(screen.queryByText("Nada espera por ti.")).toBeNull();
  });

  it("muestra la pregunta abierta con su contexto y la responde", async () => {
    const { fake, project } = seeded();
    const task = fake.addTask(project.id, { intent: "Migrar usuarios" });
    fake.transition(task.id, "in_progress", "running");
    fake.startRun(task.id, "implement");
    fake.ask(task.id, "¿Borro la tabla vieja?", "Hay dos tablas de usuarios");
    const { user } = renderApp("/inbox", fake);

    const question = await item("Preguntas abiertas", "Migrar usuarios");
    expect(question.getByText("¿Borro la tabla vieja?")).toBeTruthy();
    expect(question.getByText("Hay dos tablas de usuarios")).toBeTruthy();
    expect(await question.findByText("Implementación")).toBeTruthy();
    await user.type(question.getByLabelText("Respuesta"), "Sí, bórrala");
    await user.click(question.getByRole("button", { name: "Responder" }));

    expect(await screen.findByText("Ningún agente espera una respuesta.")).toBeTruthy();
    expect(fake.questions[0]).toMatchObject({ status: "answered", answer: "Sí, bórrala" });
    expect(fake.task(task.id).subState).toBe("queued");
    expect(await screen.findByRole("status")).toHaveProperty(
      "textContent",
      "Respuesta enviada: irá a un agente nuevo.",
    );
  });

  it("si la pregunta ya no está abierta muestra el error del servidor", async () => {
    const { fake, project } = seeded();
    const task = fake.addTask(project.id, { intent: "Migrar usuarios" });
    fake.transition(task.id, "in_progress", "running");
    const asked = fake.ask(task.id, "¿Borro la tabla vieja?");
    const { user } = renderApp("/inbox", fake);

    const question = await item("Preguntas abiertas", "Migrar usuarios");
    asked.status = "cancelled";
    await user.type(question.getByLabelText("Respuesta"), "Sí");
    await user.click(question.getByRole("button", { name: "Responder" }));

    const questions = await section("Preguntas abiertas");
    expect((await questions.findByRole("alert")).textContent).toMatch(/ya está en cancelled/);
    // La pregunta ya no espera: sale de la bandeja sin esperar el refresco.
    expect(await questions.findByText("Ningún agente espera una respuesta.")).toBeTruthy();
  });

  it("muestra el agente bloqueado y enfoca su pane en herdr", async () => {
    const { fake, project } = seeded();
    const task = fake.addTask(project.id, { intent: "Agregar índice" });
    fake.transition(task.id, "in_progress", "running");
    const run = fake.startRun(task.id, "implement");
    const blocked = fake.block(run);
    const { user } = renderApp("/inbox", fake);

    const agent = await item("Agentes bloqueados", "Agregar índice");
    expect(agent.getByText(blocked.agentName)).toBeTruthy();
    expect(agent.getByText(blocked.paneId)).toBeTruthy();
    expect(agent.getByText(`herdr agent focus ${blocked.agentName}`)).toBeTruthy();
    await user.click(agent.getByRole("button", { name: "Abrir pane en herdr" }));

    expect(fake.focused).toEqual([blocked.agentName]);
    expect((await agent.findByRole("status")).textContent).toBe(
      "Pane enfocado en herdr: responde el permiso ahí.",
    );
  });

  it("si herdr ya no tiene el agente lo dice", async () => {
    const { fake, project } = seeded();
    const task = fake.addTask(project.id, { intent: "Agregar índice" });
    fake.block(fake.startRun(task.id, "implement"));
    fake.focusError = {
      status: 409,
      error: "agent_gone",
      message: "el agente ya no está en herdr",
    };
    const { user } = renderApp("/inbox", fake);

    const agent = await item("Agentes bloqueados", "Agregar índice");
    await user.click(agent.getByRole("button", { name: "Abrir pane en herdr" }));
    expect((await agent.findByRole("alert")).textContent).toMatch(/ya no está en herdr/);
  });

  it("el agente desbloqueado sale de la bandeja al refrescar", async () => {
    const { fake, project } = seeded();
    const task = fake.addTask(project.id, { intent: "Agregar índice" });
    fake.block(fake.startRun(task.id, "implement"));
    const { refresh } = renderApp("/inbox", fake);
    await item("Agentes bloqueados", "Agregar índice");

    fake.blocked = [];
    await refresh();
    expect(await screen.findByText("Ningún agente espera un permiso.")).toBeTruthy();
  });

  it("el menú muestra cuántas cosas esperan al humano", async () => {
    const { fake, project } = seeded();
    const refined = fake.addTask(project.id, { intent: "Spec" });
    fake.addSpec(refined.id);
    fake.transition(refined.id, "refined", null);
    const asking = fake.addTask(project.id, { intent: "Pregunta" });
    fake.transition(asking.id, "in_progress", "running");
    fake.ask(asking.id, "¿Sí?");
    fake.block(fake.startRun(asking.id, "implement"));
    renderApp("/queue", fake);

    const nav = within(await screen.findByRole("navigation"));
    await waitFor(() =>
      expect(nav.getByRole("link", { name: "Bandeja, 3 pendientes" })).toBeTruthy(),
    );
  });

  it("las preguntas y bloqueos se resuelven en la bandeja y la spec en el detalle", async () => {
    const { fake, project } = seeded();
    const refined = fake.addTask(project.id, { intent: "Spec pendiente" });
    fake.addSpec(refined.id);
    fake.transition(refined.id, "refined", null);
    const asking = fake.addTask(project.id, { intent: "Pregunta pendiente" });
    fake.transition(asking.id, "in_progress", "running");
    fake.startRun(asking.id, "implement");
    fake.ask(asking.id, "¿Mantengo la API vieja?");
    const stuck = fake.addTask(project.id, { intent: "Permiso pendiente" });
    fake.transition(stuck.id, "in_progress", "running");
    fake.block(fake.startRun(stuck.id, "implement"));
    const { user, refresh } = renderApp("/inbox", fake);

    const question = await item("Preguntas abiertas", "Pregunta pendiente");
    await user.type(question.getByLabelText("Respuesta"), "No");
    await user.click(question.getByRole("button", { name: "Responder" }));
    const agent = await item("Agentes bloqueados", "Permiso pendiente");
    await user.click(agent.getByRole("button", { name: "Abrir pane en herdr" }));
    await agent.findByRole("status");
    // El humano responde el permiso en herdr y el RunWatcher deja de verlo bloqueado.
    fake.blocked = [];
    await refresh();
    expect(await screen.findByText("Ningún agente espera un permiso.")).toBeTruthy();

    await user.click((await specRow("Spec pendiente")).getByRole("link"));
    await user.click(await (await section("Spec")).findByRole("button", { name: "Aprobar v1" }));
    expect(await screen.findByText("In progress")).toBeTruthy();
    const nav = within(screen.getByRole("navigation"));
    await user.click(nav.getByRole("link", { name: /^Bandeja/ }));

    expect(await screen.findByText("Nada espera por ti.")).toBeTruthy();
    expect(fake.task(refined.id).state).toBe("in_progress");
    expect(fake.task(asking.id).subState).toBe("queued");
    expect(fake.focused).toHaveLength(1);
  });

  it.each([
    ["aprueba", "in_progress"],
    ["pide cambios", "draft"],
    ["edita y aprueba", "in_progress"],
  ] as const)("si el humano %s en el detalle la spec sale de la bandeja", async (action, state) => {
    const { fake, project } = seeded();
    const task = fake.addTask(project.id, { intent: "Login con email" });
    fake.addSpec(task.id);
    fake.transition(task.id, "refined", null);
    const { user } = renderApp("/inbox", fake);

    await user.click((await specRow("Login con email")).getByRole("link"));
    const spec = await section("Spec");
    if (action === "aprueba") {
      await user.click(await spec.findByRole("button", { name: "Aprobar v1" }));
    } else if (action === "pide cambios") {
      await user.type(await spec.findByLabelText("Comentarios"), "Falta el logout");
      await user.click(spec.getByRole("button", { name: "Pedir cambios" }));
    } else {
      await user.click(await spec.findByRole("button", { name: "Editar y aprobar" }));
      await user.click(spec.getByRole("button", { name: "Guardar y aprobar" }));
    }
    await waitFor(() => expect(fake.task(task.id).state).toBe(state));
    const nav = within(screen.getByRole("navigation"));
    await user.click(nav.getByRole("link", { name: /^Bandeja/ }));

    expect(
      await (await section("Specs por aprobar")).findByText("Ninguna spec espera aprobación."),
    ).toBeTruthy();
  });

  it.each([
    ["/api/questions", "Preguntas abiertas", "Ningún agente espera una respuesta."],
    ["/api/tasks", "Specs por aprobar", "Ninguna spec espera aprobación."],
  ])("si falla %s no se lee como bandeja vacía", async (path, sectionName, empty) => {
    const { fake } = seeded();
    const route = fake.fetch;
    const failing = async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).startsWith(path)
        ? new Response(JSON.stringify({ error: "internal" }), { status: 500 })
        : route(input, init);
    renderApp("/inbox", Object.assign(fake, { fetch: failing }));

    expect(await (await section(sectionName)).findByRole("alert")).toBeTruthy();
    expect(screen.queryByText("Nada espera por ti.")).toBeNull();
    expect(screen.queryByText(empty)).toBeNull();
  });

  it("los bloqueos se refrescan solos aunque no lleguen eventos", () => {
    expect(queries.blocked().refetchInterval).toBe(BLOCKED_REFRESH_MS);
  });
});
