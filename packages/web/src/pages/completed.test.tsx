import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FakeApi } from "../../test/fake-api.ts";
import { renderApp } from "../../test/render.tsx";

describe("pestaña Completed", () => {
  it("enlaza desde la navegación y lista tareas completadas de todos los proyectos", async () => {
    const fake = new FakeApi();
    const one = fake.addProject({ name: "uno" });
    const two = fake.addProject({ name: "dos" });
    const complete = fake.addTask(one.id, {
      intent: "Tarea terminada",
      title: "Entrega lista",
      state: "completed",
      subState: null,
      prUrl: "https://github.com/o/r/pull/7",
      prState: "merged",
    });
    fake.addTask(two.id, { intent: "Otra completada", state: "completed", subState: null });
    fake.addTask(one.id, { intent: "En curso", state: "in_progress", subState: "running" });
    const { user, router } = renderApp("/queue", fake);
    const nav = within(await screen.findByRole("navigation"));
    const link = nav.getByRole("link", { name: "Completed" });

    expect(link.getAttribute("href")).toBe("/completed");
    await user.click(link);
    await waitFor(() => expect(router.state.location.pathname).toBe("/completed"));
    expect(nav.getByRole("link", { name: "Completed" }).className).toContain("bg-muted");
    expect(await screen.findByRole("heading", { name: "Completed" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Entrega lista" })).toHaveProperty(
      "href",
      expect.stringContaining(`/tasks/${complete.id}`),
    );
    expect(
      within(screen.getByRole("row", { name: /Entrega lista/ })).getByText("uno"),
    ).toBeTruthy();
    expect(
      within(screen.getByRole("row", { name: /Otra completada/ })).getByText("dos"),
    ).toBeTruthy();
    expect(within(screen.getByRole("table")).queryByText("En curso")).toBeNull();
  });

  it("filtra las tareas completadas por proyecto y muestra el estado vacío", async () => {
    const fake = new FakeApi();
    const one = fake.addProject({ name: "uno" });
    const two = fake.addProject({ name: "dos" });
    fake.addTask(one.id, { intent: "De uno", state: "completed", subState: null });
    fake.addTask(two.id, { intent: "De dos", state: "completed", subState: null });
    const { user } = renderApp("/completed", fake);

    await screen.findByText("De dos");
    await user.selectOptions(screen.getByLabelText("Proyecto"), one.id);
    await waitFor(() => expect(screen.queryByText("De dos")).toBeNull());
    expect(screen.getByText("De uno")).toBeTruthy();

    await user.selectOptions(screen.getByLabelText("Proyecto"), "");
    await waitFor(() => expect(screen.getByText("De uno")).toBeTruthy());
    expect(screen.getByText("De dos")).toBeTruthy();
  });

  it("explica cuando no hay tareas completadas", async () => {
    const fake = new FakeApi();
    fake.addTask(fake.addProject().id, {
      intent: "En cola",
      state: "draft",
      subState: "queued",
    });
    renderApp("/completed", fake);
    expect(await screen.findByText("No hay tareas completadas.")).toBeTruthy();
  });
});
