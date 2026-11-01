import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FakeApi } from "../../test/fake-api.ts";
import { renderApp } from "../../test/render.tsx";
import { buttonVariants } from "../components/ui/button.tsx";

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
    expect(nav.getByRole("link", { name: "Completed" }).className).toContain("bg-primary/10");
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
  it("muestra el PR como botón outline sm que abre en otra pestaña", async () => {
    const fake = new FakeApi();
    fake.addTask(fake.addProject().id, {
      intent: "Con PR",
      state: "completed",
      subState: null,
      prUrl: "https://github.com/o/r/pull/7",
      prState: "merged",
    });
    renderApp("/completed", fake);

    const row = within(await screen.findByRole("row", { name: /Con PR/ }));
    const link = row.getByRole("link", { name: "PR merged" });
    expect(link.getAttribute("href")).toBe("https://github.com/o/r/pull/7");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noreferrer");
    for (const cls of buttonVariants({ variant: "outline", size: "sm" }).split(" ")) {
      expect(link.classList.contains(cls)).toBe(true);
    }
  });

  it("el botón del PR lleva un icono de enlace externo decorativo", async () => {
    const fake = new FakeApi();
    fake.addTask(fake.addProject().id, {
      intent: "Con PR",
      state: "completed",
      subState: null,
      prUrl: "https://github.com/o/r/pull/7",
      prState: "merged",
    });
    renderApp("/completed", fake);

    const link = await screen.findByRole("link", { name: "PR merged" });
    const icon = link.querySelector("svg");
    expect(icon?.getAttribute("data-icon")).toBe("external-link");
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
  });

  it("sin prUrl la celda del PR es texto, sin enlace ni icono", async () => {
    const fake = new FakeApi();
    fake.addTask(fake.addProject().id, {
      intent: "Sin PR",
      state: "completed",
      subState: null,
      prUrl: null,
      prState: null,
    });
    renderApp("/completed", fake);

    const row = within(await screen.findByRole("row", { name: /Sin PR/ }));
    expect(row.getByText("—")).toBeTruthy();
    expect(row.queryByRole("link", { name: /^PR / })).toBeNull();
    expect(document.querySelector('[data-icon="external-link"]')).toBeNull();
  });
});
