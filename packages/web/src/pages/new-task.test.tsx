import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FakeApi } from "../../test/fake-api.ts";
import { renderApp } from "../../test/render.tsx";
import { queries } from "../lib/queries.ts";

/** The labels of the dependency selector's options (#N · intent), without the placeholder. */
function candidateOptions(): string[] {
  const select = screen.getByLabelText("Depende de") as HTMLSelectElement;
  return [...select.options].filter((o) => o.value !== "").map((o) => o.text);
}

/** The value of the option whose intent is the given one: the label carries the #N in front. */
function optionOf(intent: string): string {
  const select = screen.getByLabelText("Depende de") as HTMLSelectElement;
  const option = [...select.options].find((o) => o.text.endsWith(` · ${intent}`));
  if (!option) throw new Error(`sin opción para «${intent}»`);
  return option.value;
}

function chosen(): string[] {
  const list = screen.queryByRole("list", { name: "Dependencias elegidas" });
  if (!list) return [];
  return within(list)
    .queryAllByRole("listitem")
    .map((item) => item.querySelector("[data-intent]")?.textContent ?? "");
}

describe("task creation", () => {
  it("creates the task with tags, priority and dependencies and opens its detail", async () => {
    const fake = new FakeApi();
    const project = fake.addProject({ name: "lunas-queue" });
    const dep = fake.addTask(project.id, { intent: "Base de datos" });
    const { user, router } = renderApp("/tasks/new", fake);

    await user.selectOptions(await screen.findByLabelText("Proyecto"), "lunas-queue");
    await user.type(screen.getByLabelText("Intent"), "Login con email");
    await user.type(screen.getByLabelText("Tags"), "auth, ui ,");
    await user.clear(screen.getByLabelText("Prioridad"));
    await user.type(screen.getByLabelText("Prioridad"), "250");
    await user.selectOptions(await screen.findByLabelText("Depende de"), optionOf("Base de datos"));
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

  it("«Depende de» is a task selector, without checkboxes", async () => {
    const fake = new FakeApi();
    const project = fake.addProject({ name: "lunas-queue" });
    fake.addTask(project.id, { intent: "Base de datos" });
    const { user } = renderApp("/tasks/new", fake);

    await user.selectOptions(await screen.findByLabelText("Proyecto"), "lunas-queue");
    const select = await screen.findByLabelText("Depende de");
    expect(select.tagName).toBe("SELECT");
    expect(candidateOptions()).toHaveLength(1);
    expect(candidateOptions()[0]).toMatch(/^#\d+ · Base de datos$/);
    expect(screen.queryAllByRole("checkbox")).toEqual([]);
  });

  it("the selector and the list of chosen ones show each task's #N", async () => {
    const fake = new FakeApi();
    const project = fake.addProject({ name: "lunas-queue" });
    const dep = fake.addTask(project.id, { intent: "Base de datos", number: 17 });
    const { user } = renderApp("/tasks/new", fake);

    await user.selectOptions(await screen.findByLabelText("Proyecto"), "lunas-queue");
    expect(await screen.findByRole("option", { name: "#17 · Base de datos" })).toBeTruthy();
    await user.selectOptions(screen.getByLabelText("Depende de"), dep.id);

    const list = screen.getByRole("list", { name: "Dependencias elegidas" });
    expect(within(list).getByText("#17")).toBeTruthy();
    expect(within(list).getByText("Base de datos")).toBeTruthy();
  });

  it("the selector does not offer terminal tasks", async () => {
    const fake = new FakeApi();
    const project = fake.addProject({ name: "lunas-queue" });
    fake.addTask(project.id, { intent: "Viva" });
    fake.addTask(project.id, { intent: "Ya cancelada", state: "cancelled", subState: null });
    const { user } = renderApp("/tasks/new", fake);

    await user.selectOptions(await screen.findByLabelText("Proyecto"), "lunas-queue");
    await screen.findByLabelText("Depende de");
    expect(candidateOptions()).toHaveLength(1);
    expect(candidateOptions()[0]).toMatch(/ · Viva$/);
  });

  it("choosing a task adds it to the list, removes it from the selector and goes back to the placeholder", async () => {
    const fake = new FakeApi();
    const project = fake.addProject({ name: "lunas-queue" });
    fake.addTask(project.id, { intent: "Base de datos" });
    fake.addTask(project.id, { intent: "API" });
    const { user } = renderApp("/tasks/new", fake);

    await user.selectOptions(await screen.findByLabelText("Proyecto"), "lunas-queue");
    await user.selectOptions(await screen.findByLabelText("Depende de"), optionOf("Base de datos"));

    expect(chosen()).toEqual(["Base de datos"]);
    expect(candidateOptions()).toHaveLength(1);
    expect(candidateOptions()[0]).toMatch(/ · API$/);
    expect((screen.getByLabelText("Depende de") as HTMLSelectElement).value).toBe("");
  });

  it("removing a dependency returns it to the selector and keeps the others", async () => {
    const fake = new FakeApi();
    const project = fake.addProject({ name: "lunas-queue" });
    fake.addTask(project.id, { intent: "Base de datos" });
    fake.addTask(project.id, { intent: "API" });
    const { user } = renderApp("/tasks/new", fake);

    await user.selectOptions(await screen.findByLabelText("Proyecto"), "lunas-queue");
    await user.selectOptions(await screen.findByLabelText("Depende de"), optionOf("Base de datos"));
    await user.selectOptions(screen.getByLabelText("Depende de"), optionOf("API"));
    expect(chosen()).toEqual(["Base de datos", "API"]);

    await user.click(screen.getByRole("button", { name: "Quitar Base de datos" }));
    expect(chosen()).toEqual(["API"]);
    expect(candidateOptions()).toHaveLength(1);
    expect(candidateOptions()[0]).toMatch(/ · Base de datos$/);
  });

  it("sends dependsOn with the chosen ones in the order they were added", async () => {
    const fake = new FakeApi();
    const project = fake.addProject({ name: "lunas-queue" });
    const db = fake.addTask(project.id, { intent: "Base de datos" });
    const api = fake.addTask(project.id, { intent: "API" });
    const { user } = renderApp("/tasks/new", fake);

    await user.selectOptions(await screen.findByLabelText("Proyecto"), "lunas-queue");
    await user.type(screen.getByLabelText("Intent"), "Pantalla");
    await user.selectOptions(await screen.findByLabelText("Depende de"), optionOf("API"));
    await user.selectOptions(screen.getByLabelText("Depende de"), optionOf("Base de datos"));
    await user.click(screen.getByRole("button", { name: "Crear tarea" }));

    await screen.findByRole("heading", { name: "Pantalla" });
    expect(fake.requests.find((r) => r.method === "POST")?.body).toMatchObject({
      dependsOn: [api.id, db.id],
    });
  });

  it("allows depending on tasks of another project and marks them", async () => {
    const fake = new FakeApi();
    const mine = fake.addProject({ name: "web" });
    const other = fake.addProject({ name: "api" });
    const remote = fake.addTask(other.id, { intent: "Endpoint de login" });
    const { user } = renderApp("/tasks/new", fake);

    await user.selectOptions(await screen.findByLabelText("Proyecto"), "web");
    const select = await screen.findByLabelText("Depende de");
    expect(select.querySelector('optgroup[label="api · otro proyecto"]')).not.toBeNull();
    await user.type(screen.getByLabelText("Intent"), "Pantalla de login");
    await user.selectOptions(select, optionOf("Endpoint de login"));
    const list = screen.getByRole("list", { name: "Dependencias elegidas" });
    expect(within(list).getByText("otro proyecto")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Crear tarea" }));
    await screen.findByRole("heading", { name: "Pantalla de login" });
    expect(fake.requests.find((r) => r.method === "POST")?.body).toMatchObject({
      projectId: mine.id,
      dependsOn: [remote.id],
    });
  });

  it("changing project empties the chosen dependencies", async () => {
    const fake = new FakeApi();
    const one = fake.addProject({ name: "uno" });
    fake.addProject({ name: "dos" });
    fake.addTask(one.id, { intent: "Base de datos" });
    const { user } = renderApp("/tasks/new", fake);

    await user.selectOptions(await screen.findByLabelText("Proyecto"), "uno");
    await user.selectOptions(await screen.findByLabelText("Depende de"), optionOf("Base de datos"));
    expect(chosen()).toEqual(["Base de datos"]);

    await user.selectOptions(screen.getByLabelText("Proyecto"), "dos");
    expect(chosen()).toEqual([]);
  });

  it("does not show «Depende de» if there are no live tasks", async () => {
    const fake = new FakeApi();
    const project = fake.addProject({ name: "uno" });
    fake.addTask(project.id, { intent: "Ya cancelada", state: "cancelled", subState: null });
    const { user, queryClient } = renderApp("/tasks/new", fake);

    await user.selectOptions(await screen.findByLabelText("Proyecto"), "uno");
    await screen.findByLabelText("Intent");
    // Waits for the candidates to be loaded: without this the absence would be trivial.
    await waitFor(() =>
      expect(queryClient.getQueryState(queries.tasks().queryKey)?.status).toBe("success"),
    );
    expect(screen.queryByText("Depende de")).toBeNull();
    expect(screen.queryByLabelText("Depende de")).toBeNull();
  });

  it("groups the candidates with the chosen project first", async () => {
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

  it("preselects the project from the URL", async () => {
    const fake = new FakeApi();
    fake.addProject({ name: "uno" });
    const two = fake.addProject({ name: "dos" });
    renderApp(`/tasks/new?projectId=${two.id}`, fake);
    await waitFor(() =>
      expect((screen.getByLabelText("Proyecto") as HTMLSelectElement).value).toBe(two.id),
    );
  });

  it("shows the server's validation errors", async () => {
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
