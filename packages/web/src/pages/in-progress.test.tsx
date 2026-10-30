import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FakeApi } from "../../test/fake-api.ts";
import { renderApp } from "../../test/render.tsx";

describe("pestaña En curso", () => {
  it("el enlace En curso de la navegación lleva a /in-progress y queda activo", async () => {
    const { user, router } = renderApp("/queue");
    const nav = within(await screen.findByRole("navigation"));
    const link = nav.getByRole("link", { name: "En curso" });
    expect(link.getAttribute("href")).toBe("/in-progress");
    expect(link.className).not.toContain("bg-muted");

    await user.click(link);
    await waitFor(() => expect(router.state.location.pathname).toBe("/in-progress"));
    expect(nav.getByRole("link", { name: "En curso" }).className).toContain("bg-muted");
    expect(await screen.findByRole("heading", { name: "En curso" })).toBeTruthy();
  });

  it("lista solo las tareas In progress de todos los proyectos, con proyecto, sub-estado y prioridad", async () => {
    const fake = new FakeApi();
    const one = fake.addProject({ name: "uno" });
    const two = fake.addProject({ name: "dos" });
    fake.addTask(one.id, { intent: "Borrador" });
    fake.addTask(one.id, { intent: "Verificando", state: "verification", subState: "running" });
    fake.addTask(two.id, { intent: "Terminada", state: "completed", subState: null });
    const running = fake.addTask(one.id, {
      intent: "Corriendo en uno",
      state: "in_progress",
      subState: "running",
      priority: 300,
    });
    fake.addTask(two.id, {
      intent: "Esperando en dos",
      state: "in_progress",
      subState: "waiting_human",
      priority: 50,
    });
    renderApp("/in-progress", fake);

    const link = await screen.findByRole("link", { name: "Corriendo en uno" });
    expect(link.getAttribute("href")).toBe(`/tasks/${running.id}`);
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getAllByRole("cell").map((c) => c.textContent))).toEqual([
      ["Corriendo en uno", "uno", "corriendo", "300"],
      ["Esperando en dos", "dos", "esperando humano", "50"],
    ]);
    expect(screen.queryByText("Borrador")).toBeNull();
    expect(screen.queryByText("Verificando")).toBeNull();
    expect(screen.queryByText("Terminada")).toBeNull();
  });

  it("filtra por proyecto y Todos vuelve a mostrar ambos", async () => {
    const fake = new FakeApi();
    const one = fake.addProject({ name: "uno" });
    const two = fake.addProject({ name: "dos" });
    fake.addTask(one.id, { intent: "De uno", state: "in_progress", subState: "running" });
    fake.addTask(two.id, { intent: "De dos", state: "in_progress", subState: "queued" });
    const { user } = renderApp("/in-progress", fake);

    await screen.findByText("De dos");
    await user.selectOptions(screen.getByLabelText("Proyecto"), "uno");
    await waitFor(() => expect(screen.queryByText("De dos")).toBeNull());
    expect(screen.getByText("De uno")).toBeTruthy();

    await user.selectOptions(screen.getByLabelText("Proyecto"), "");
    expect(await screen.findByText("De dos")).toBeTruthy();
    expect(screen.getByText("De uno")).toBeTruthy();
  });

  it("explica que no hay tareas en curso, sin tabla vacía", async () => {
    const fake = new FakeApi();
    fake.addTask(fake.addProject().id, { intent: "Borrador" });
    renderApp("/in-progress", fake);

    expect(await screen.findByText("No hay tareas en curso.")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });
});
