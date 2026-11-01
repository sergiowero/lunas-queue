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

  describe("filtro Estado del PR", () => {
    const completed = { state: "completed", subState: null } as const;

    function seedAllStates() {
      const fake = new FakeApi();
      const project = fake.addProject({ name: "uno" });
      fake.addTask(project.id, { ...completed, intent: "Con merged", prState: "merged" });
      fake.addTask(project.id, { ...completed, intent: "Con open", prState: "open" });
      fake.addTask(project.id, { ...completed, intent: "Con closed", prState: "closed" });
      fake.addTask(project.id, { ...completed, intent: "Sin ningún PR", prState: null });
      return fake;
    }

    it("arranca en Todos y ofrece Todos, open, merged, closed y Sin PR", async () => {
      renderApp("/completed", seedAllStates());

      const select = (await screen.findByLabelText("Estado del PR")) as HTMLSelectElement;
      expect(select.value).toBe("");
      expect(Array.from(select.options).map((option) => option.textContent)).toEqual([
        "Todos",
        "open",
        "merged",
        "closed",
        "Sin PR",
      ]);
    });

    it("muestra solo las tareas con el estado de PR elegido", async () => {
      const { user } = renderApp("/completed", seedAllStates());

      await screen.findByText("Con open");
      await user.selectOptions(screen.getByLabelText("Estado del PR"), "merged");

      await waitFor(() => expect(screen.queryByText("Con open")).toBeNull());
      expect(screen.getByText("Con merged")).toBeTruthy();
      expect(screen.queryByText("Con closed")).toBeNull();
      expect(screen.queryByText("Sin ningún PR")).toBeNull();
    });

    it("Sin PR muestra solo las tareas completadas sin estado de PR", async () => {
      const { user } = renderApp("/completed", seedAllStates());

      await screen.findByText("Con merged");
      await user.selectOptions(screen.getByLabelText("Estado del PR"), "Sin PR");

      await waitFor(() => expect(screen.queryByText("Con merged")).toBeNull());
      expect(screen.getByText("Sin ningún PR")).toBeTruthy();
      expect(screen.queryByText("Con open")).toBeNull();
    });

    it("volver a Todos muestra de nuevo todas las tareas completadas", async () => {
      const { user } = renderApp("/completed", seedAllStates());

      await screen.findByText("Con merged");
      await user.selectOptions(screen.getByLabelText("Estado del PR"), "closed");
      await waitFor(() => expect(screen.queryByText("Con merged")).toBeNull());
      await user.selectOptions(screen.getByLabelText("Estado del PR"), "Todos");

      await waitFor(() => expect(screen.getByText("Con merged")).toBeTruthy());
      for (const intent of ["Con open", "Con closed", "Sin ningún PR"]) {
        expect(screen.getByText(intent)).toBeTruthy();
      }
    });

    it("se combina con el filtro de proyecto", async () => {
      const fake = new FakeApi();
      const one = fake.addProject({ name: "uno" });
      const two = fake.addProject({ name: "dos" });
      fake.addTask(one.id, { ...completed, intent: "Merged de uno", prState: "merged" });
      fake.addTask(two.id, { ...completed, intent: "Merged de dos", prState: "merged" });
      fake.addTask(one.id, { ...completed, intent: "Open de uno", prState: "open" });
      const { user } = renderApp("/completed", fake);

      await screen.findByText("Merged de dos");
      await user.selectOptions(screen.getByLabelText("Proyecto"), one.id);
      await user.selectOptions(screen.getByLabelText("Estado del PR"), "merged");

      await waitFor(() => expect(screen.queryByText("Merged de dos")).toBeNull());
      expect(screen.getByText("Merged de uno")).toBeTruthy();
      expect(screen.queryByText("Open de uno")).toBeNull();
    });

    it("nunca muestra tareas que no están completadas y cae al estado vacío", async () => {
      const fake = new FakeApi();
      const project = fake.addProject({ name: "uno" });
      fake.addTask(project.id, {
        intent: "En curso con PR",
        state: "in_progress",
        subState: "running",
        prState: "open",
      });
      fake.addTask(project.id, { ...completed, intent: "Ya mergeada", prState: "merged" });
      const { user } = renderApp("/completed", fake);

      await screen.findByText("Ya mergeada");
      await user.selectOptions(screen.getByLabelText("Estado del PR"), "open");

      expect(await screen.findByText("No hay tareas completadas.")).toBeTruthy();
      expect(screen.queryByText("En curso con PR")).toBeNull();
    });
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
