import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FakeApi, SPEC_CONTENT } from "../../test/fake-api.ts";
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

describe("bandeja", () => {
  it("sin nada pendiente lo dice en cada sección", async () => {
    const { fake } = seeded();
    renderApp("/inbox", fake);
    expect(await screen.findByText("Nada espera por ti.")).toBeTruthy();
    expect(
      await (await section("Specs por aprobar")).findByText("Ninguna spec espera aprobación."),
    ).toBeTruthy();
    expect(
      await (await section("Preguntas abiertas")).findByText("Ningún agente espera una respuesta."),
    ).toBeTruthy();
    expect(
      await (await section("Agentes bloqueados")).findByText("Ningún agente espera un permiso."),
    ).toBeTruthy();
  });

  it("muestra la spec por aprobar con su diff y la aprueba", async () => {
    const { fake, project } = seeded();
    const task = fake.addTask(project.id, { intent: "Login con email" });
    fake.addSpec(task.id);
    fake.transition(task.id, "refined", null);
    const { user } = renderApp("/inbox", fake);

    const spec = await item("Specs por aprobar", "Login con email");
    expect(spec.getByRole("link", { name: "Login con email" })).toBeTruthy();
    expect(await spec.findByText("lunas-queue")).toBeTruthy();
    expect(await spec.findByText(/AC-1: dado un usuario/)).toBeTruthy();
    expect(await spec.findByText("Primera versión")).toBeTruthy();
    await user.click(spec.getByRole("button", { name: "Aprobar v1" }));

    expect(await screen.findByText("Ninguna spec espera aprobación.")).toBeTruthy();
    expect(fake.task(task.id).state).toBe("in_progress");
  });

  it("pide cambios a la spec desde la bandeja", async () => {
    const { fake, project } = seeded();
    const task = fake.addTask(project.id, { intent: "Login con email" });
    fake.addSpec(task.id);
    fake.transition(task.id, "refined", null);
    const { user } = renderApp("/inbox", fake);

    const spec = await item("Specs por aprobar", "Login con email");
    await user.type(await spec.findByLabelText("Comentarios"), "Falta el logout");
    await user.click(spec.getByRole("button", { name: "Pedir cambios" }));

    expect(await screen.findByText("Ninguna spec espera aprobación.")).toBeTruthy();
    expect(fake.task(task.id).state).toBe("draft");
    expect(fake.specs[0]?.reviewComments).toBe("Falta el logout");
  });

  it("edita la spec y la aprueba como una versión nueva del humano", async () => {
    const { fake, project } = seeded();
    const task = fake.addTask(project.id, { intent: "Login con email" });
    fake.addSpec(task.id);
    fake.transition(task.id, "refined", null);
    const { user } = renderApp("/inbox", fake);

    const spec = await item("Specs por aprobar", "Login con email");
    await user.click(await spec.findByRole("button", { name: "Editar y aprobar" }));
    const editor = spec.getByLabelText("Contenido de la spec (JSON)") as HTMLTextAreaElement;
    expect(JSON.parse(editor.value)).toEqual(SPEC_CONTENT);
    const edited = { ...SPEC_CONTENT, requirements: ["El usuario inicia sesión con SSO"] };
    await user.clear(editor);
    // user.type interpreta { y [ como teclas especiales; se pega el JSON tal cual.
    await user.click(editor);
    await user.paste(JSON.stringify(edited));
    await user.click(spec.getByRole("button", { name: "Guardar y aprobar" }));

    expect(await screen.findByText("Ninguna spec espera aprobación.")).toBeTruthy();
    const latest = fake.specs.at(-1);
    expect(latest).toMatchObject({ version: 2, createdBy: "human", approval: "approved" });
    expect(latest?.content.requirements).toEqual(["El usuario inicia sesión con SSO"]);
    expect(fake.task(task.id).state).toBe("in_progress");
  });

  it("no manda una edición que no es JSON válido", async () => {
    const { fake, project } = seeded();
    const task = fake.addTask(project.id, { intent: "Login con email" });
    fake.addSpec(task.id);
    fake.transition(task.id, "refined", null);
    const { user } = renderApp("/inbox", fake);

    const spec = await item("Specs por aprobar", "Login con email");
    await user.click(await spec.findByRole("button", { name: "Editar y aprobar" }));
    const editor = spec.getByLabelText("Contenido de la spec (JSON)");
    await user.clear(editor);
    await user.type(editor, "no es json");
    await user.click(spec.getByRole("button", { name: "Guardar y aprobar" }));

    expect((await spec.findByRole("alert")).textContent).toMatch(/JSON inválido/);
    expect(fake.requests.some((r) => r.path.endsWith("/edit-and-approve"))).toBe(false);
  });

  it("muestra los errores de validación del servidor al editar", async () => {
    const { fake, project } = seeded();
    const task = fake.addTask(project.id, { intent: "Login con email" });
    fake.addSpec(task.id);
    fake.transition(task.id, "refined", null);
    const { user } = renderApp("/inbox", fake);

    const spec = await item("Specs por aprobar", "Login con email");
    await user.click(await spec.findByRole("button", { name: "Editar y aprobar" }));
    const editor = spec.getByLabelText("Contenido de la spec (JSON)");
    await user.clear(editor);
    await user.click(editor);
    await user.paste("{}");
    await user.click(spec.getByRole("button", { name: "Guardar y aprobar" }));

    expect((await spec.findByRole("alert")).textContent).toMatch(/content: Invalid input/);
    expect(fake.task(task.id).state).toBe("refined");
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

  it("todo lo que espera al humano aparece y se resuelve desde la bandeja", async () => {
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

    const spec = await item("Specs por aprobar", "Spec pendiente");
    await user.click(await spec.findByRole("button", { name: "Aprobar v1" }));
    const question = await item("Preguntas abiertas", "Pregunta pendiente");
    await user.type(question.getByLabelText("Respuesta"), "No");
    await user.click(question.getByRole("button", { name: "Responder" }));
    const agent = await item("Agentes bloqueados", "Permiso pendiente");
    await user.click(agent.getByRole("button", { name: "Abrir pane en herdr" }));
    await agent.findByRole("status");
    // El humano responde el permiso en herdr y el RunWatcher deja de verlo bloqueado.
    fake.blocked = [];
    await refresh();

    expect(await screen.findByText("Nada espera por ti.")).toBeTruthy();
    expect(fake.task(refined.id).state).toBe("in_progress");
    expect(fake.task(asking.id).subState).toBe("queued");
    expect(fake.focused).toHaveLength(1);
  });

  it("una consulta fallida no se lee como bandeja vacía", async () => {
    const { fake } = seeded();
    const route = fake.fetch;
    const failing = async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).startsWith("/api/questions")
        ? new Response(JSON.stringify({ error: "internal" }), { status: 500 })
        : route(input, init);
    renderApp("/inbox", Object.assign(fake, { fetch: failing }));

    expect(await (await section("Preguntas abiertas")).findByRole("alert")).toBeTruthy();
    expect(screen.queryByText("Nada espera por ti.")).toBeNull();
  });

  it("los bloqueos se refrescan solos aunque no lleguen eventos", () => {
    expect(queries.blocked().refetchInterval).toBe(BLOCKED_REFRESH_MS);
  });
});
