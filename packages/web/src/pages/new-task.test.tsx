import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FakeApi } from "../../test/fake-api.ts";
import { renderApp } from "../../test/render.tsx";

/** Las etiquetas de las opciones del selector de dependencias, sin el placeholder. */
function candidateOptions(): string[] {
  const select = screen.getByLabelText("Depende de") as HTMLSelectElement;
  return [...select.options].filter((o) => o.value !== "").map((o) => o.text);
}

function chosen(): string[] {
  const list = screen.queryByRole("list", { name: "Dependencias elegidas" });
  if (!list) return [];
  return within(list)
    .queryAllByRole("listitem")
    .map((item) => item.querySelector("[data-intent]")?.textContent ?? "");
}

describe("alta de tareas", () => {
  it("crea la tarea con tags, prioridad y dependencias y abre su detalle", async () => {
    const fake = new FakeApi();
    const project = fake.addProject({ name: "lunas-queue" });
    const dep = fake.addTask(project.id, { intent: "Base de datos" });
    const { user, router } = renderApp("/tasks/new", fake);

    await user.selectOptions(await screen.findByLabelText("Proyecto"), "lunas-queue");
    await user.type(screen.getByLabelText("Intent"), "Login con email");
    await user.type(screen.getByLabelText("Tags"), "auth, ui ,");
    await user.clear(screen.getByLabelText("Prioridad"));
    await user.type(screen.getByLabelText("Prioridad"), "250");
    await user.selectOptions(await screen.findByLabelText("Depende de"), "Base de datos");
    await user.click(screen.getByRole("button", { name: "Crear tarea" }));

    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/tasks\/[0-9a-f-]+$/));
    expect(fake.requests.find((r) => r.method === "POST")?.body).toEqual({
      projectId: project.id,
      intent: "Login con email",
      tags: ["auth", "ui"],
      priority: 250,
      dependsOn: [dep.id],
    });
    expect(await screen.findByRole("heading", { name: "Login con email" })).toBeTruthy();
  });

  it("«Depende de» es un selector de tareas, sin checkboxes", async () => {
    const fake = new FakeApi();
    const project = fake.addProject({ name: "lunas-queue" });
    fake.addTask(project.id, { intent: "Base de datos" });
    const { user } = renderApp("/tasks/new", fake);

    await user.selectOptions(await screen.findByLabelText("Proyecto"), "lunas-queue");
    const select = await screen.findByLabelText("Depende de");
    expect(select.tagName).toBe("SELECT");
    expect(candidateOptions()).toEqual(["Base de datos"]);
    expect(screen.queryAllByRole("checkbox")).toEqual([]);
  });

  it("el selector no ofrece tareas terminales", async () => {
    const fake = new FakeApi();
    const project = fake.addProject({ name: "lunas-queue" });
    fake.addTask(project.id, { intent: "Viva" });
    fake.addTask(project.id, { intent: "Ya cancelada", state: "cancelled", subState: null });
    const { user } = renderApp("/tasks/new", fake);

    await user.selectOptions(await screen.findByLabelText("Proyecto"), "lunas-queue");
    await screen.findByLabelText("Depende de");
    expect(candidateOptions()).toEqual(["Viva"]);
  });

  it("elegir una tarea la agrega a la lista, la quita del selector y vuelve al placeholder", async () => {
    const fake = new FakeApi();
    const project = fake.addProject({ name: "lunas-queue" });
    fake.addTask(project.id, { intent: "Base de datos" });
    fake.addTask(project.id, { intent: "API" });
    const { user } = renderApp("/tasks/new", fake);

    await user.selectOptions(await screen.findByLabelText("Proyecto"), "lunas-queue");
    await user.selectOptions(await screen.findByLabelText("Depende de"), "Base de datos");

    expect(chosen()).toEqual(["Base de datos"]);
    expect(candidateOptions()).toEqual(["API"]);
    expect((screen.getByLabelText("Depende de") as HTMLSelectElement).value).toBe("");
  });

  it("quitar una dependencia la devuelve al selector y conserva las demás", async () => {
    const fake = new FakeApi();
    const project = fake.addProject({ name: "lunas-queue" });
    fake.addTask(project.id, { intent: "Base de datos" });
    fake.addTask(project.id, { intent: "API" });
    const { user } = renderApp("/tasks/new", fake);

    await user.selectOptions(await screen.findByLabelText("Proyecto"), "lunas-queue");
    await user.selectOptions(await screen.findByLabelText("Depende de"), "Base de datos");
    await user.selectOptions(screen.getByLabelText("Depende de"), "API");
    expect(chosen()).toEqual(["Base de datos", "API"]);

    await user.click(screen.getByRole("button", { name: "Quitar Base de datos" }));
    expect(chosen()).toEqual(["API"]);
    expect(candidateOptions()).toEqual(["Base de datos"]);
  });

  it("envía dependsOn con las elegidas en el orden en que se agregaron", async () => {
    const fake = new FakeApi();
    const project = fake.addProject({ name: "lunas-queue" });
    const db = fake.addTask(project.id, { intent: "Base de datos" });
    const api = fake.addTask(project.id, { intent: "API" });
    const { user } = renderApp("/tasks/new", fake);

    await user.selectOptions(await screen.findByLabelText("Proyecto"), "lunas-queue");
    await user.type(screen.getByLabelText("Intent"), "Pantalla");
    await user.selectOptions(await screen.findByLabelText("Depende de"), "API");
    await user.selectOptions(screen.getByLabelText("Depende de"), "Base de datos");
    await user.click(screen.getByRole("button", { name: "Crear tarea" }));

    await screen.findByRole("heading", { name: "Pantalla" });
    expect(fake.requests.find((r) => r.method === "POST")?.body).toMatchObject({
      dependsOn: [api.id, db.id],
    });
  });

  it("permite depender de tareas de otro proyecto y las marca", async () => {
    const fake = new FakeApi();
    const mine = fake.addProject({ name: "web" });
    const other = fake.addProject({ name: "api" });
    const remote = fake.addTask(other.id, { intent: "Endpoint de login" });
    const { user } = renderApp("/tasks/new", fake);

    await user.selectOptions(await screen.findByLabelText("Proyecto"), "web");
    const select = await screen.findByLabelText("Depende de");
    expect(select.querySelector('optgroup[label="api · otro proyecto"]')).not.toBeNull();
    await user.type(screen.getByLabelText("Intent"), "Pantalla de login");
    await user.selectOptions(select, "Endpoint de login");
    const list = screen.getByRole("list", { name: "Dependencias elegidas" });
    expect(within(list).getByText("otro proyecto")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Crear tarea" }));
    await screen.findByRole("heading", { name: "Pantalla de login" });
    expect(fake.requests.find((r) => r.method === "POST")?.body).toMatchObject({
      projectId: mine.id,
      dependsOn: [remote.id],
    });
  });

  it("cambiar de proyecto vacía las dependencias elegidas", async () => {
    const fake = new FakeApi();
    const one = fake.addProject({ name: "uno" });
    fake.addProject({ name: "dos" });
    fake.addTask(one.id, { intent: "Base de datos" });
    const { user } = renderApp("/tasks/new", fake);

    await user.selectOptions(await screen.findByLabelText("Proyecto"), "uno");
    await user.selectOptions(await screen.findByLabelText("Depende de"), "Base de datos");
    expect(chosen()).toEqual(["Base de datos"]);

    await user.selectOptions(screen.getByLabelText("Proyecto"), "dos");
    expect(chosen()).toEqual([]);
  });

  it("no muestra «Depende de» si no hay tareas vivas", async () => {
    const fake = new FakeApi();
    const project = fake.addProject({ name: "uno" });
    fake.addTask(project.id, { intent: "Ya cancelada", state: "cancelled", subState: null });
    const { user } = renderApp("/tasks/new", fake);

    await user.selectOptions(await screen.findByLabelText("Proyecto"), "uno");
    await screen.findByLabelText("Intent");
    await waitFor(() => expect(fake.requests.some((r) => r.path.startsWith("/api/tasks"))).toBe(true));
    expect(screen.queryByText("Depende de")).toBeNull();
  });

  it("agrupa las candidatas con el proyecto elegido primero", async () => {
    const fake = new FakeApi();
    const first = fake.addProject({ name: "primero" });
    const chosenProject = fake.addProject({ name: "elegido" });
    fake.addTask(first.id, { intent: "Tarea de primero" });
    fake.addTask(chosenProject.id, { intent: "Tarea de elegido" });
    const { user } = renderApp("/tasks/new", fake);

    await user.selectOptions(await screen.findByLabelText("Proyecto"), "elegido");
    const select = await screen.findByLabelText("Depende de");
    const groups = [...select.querySelectorAll("optgroup")].map((g) => g.label);
    expect(groups).toEqual(["elegido", "primero · otro proyecto"]);
  });

  it("preselecciona el proyecto de la URL", async () => {
    const fake = new FakeApi();
    fake.addProject({ name: "uno" });
    const two = fake.addProject({ name: "dos" });
    renderApp(`/tasks/new?projectId=${two.id}`, fake);
    await waitFor(() =>
      expect((screen.getByLabelText("Proyecto") as HTMLSelectElement).value).toBe(two.id),
    );
  });

  it("muestra los errores de validación del servidor", async () => {
    const fake = new FakeApi();
    fake.addProject({ name: "uno" });
    const { user, router } = renderApp("/tasks/new", fake);
    await user.selectOptions(await screen.findByLabelText("Proyecto"), "uno");
    await user.type(screen.getByLabelText("Intent"), "   ");
    await user.click(screen.getByRole("button", { name: "Crear tarea" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("intent: Too small"),
    );
    expect(router.state.location.pathname).toBe("/tasks/new");
  });
});
