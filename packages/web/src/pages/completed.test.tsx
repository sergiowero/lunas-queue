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

  it("AC-10: filtrando por Sin PR, la tarea con Resultado muestra su tipo en lugar de un PR", async () => {
    const fake = new FakeApi();
    const project = fake.addProject({ name: "uno" });
    fake.addTask(project.id, {
      intent: "Investigar la cola",
      state: "completed",
      subState: null,
      resultKind: "research",
      result: "# Hallazgos",
    });
    fake.addTask(project.id, {
      intent: "Ya estaba hecha",
      state: "completed",
      subState: null,
      resultKind: "already_implemented",
      result: "Vive en src/x.ts",
    });
    fake.addTask(project.id, {
      intent: "Con PR mergeado",
      state: "completed",
      subState: null,
      prUrl: "https://github.com/o/r/pull/9",
      prState: "merged",
    });
    const { user } = renderApp("/completed", fake);

    await screen.findByText("Con PR mergeado");
    await user.selectOptions(screen.getByLabelText("Estado del PR"), "Sin PR");

    await waitFor(() => expect(screen.queryByText("Con PR mergeado")).toBeNull());
    const research = within(screen.getByRole("row", { name: /Investigar la cola/ }));
    expect(research.getByText("Investigación")).toBeTruthy();
    expect(research.queryByRole("link", { name: /PR/ })).toBeNull();
    expect(
      within(screen.getByRole("row", { name: /Ya estaba hecha/ })).getByText("Ya implementada"),
    ).toBeTruthy();
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

      expect(await screen.findByText("No hay tareas completadas con PR abierto.")).toBeTruthy();
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
    expect(await screen.findByText("No hay tareas completadas con PR abierto.")).toBeTruthy();
    expect(screen.getByText("No hay otras tareas completadas.")).toBeTruthy();
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

  describe("dos listas: PR abierto y resto colapsable", () => {
    const completed = { state: "completed", subState: null } as const;
    const openList = () => within(screen.getByRole("region", { name: "Con PR abierto" }));
    const rest = () => screen.getByTestId("completed-rest") as HTMLDetailsElement;
    const restSummary = () => screen.getByText(/^Resto \(/);

    function seedMixed() {
      const fake = new FakeApi();
      const project = fake.addProject({ name: "uno" });
      fake.addTask(project.id, {
        ...completed,
        intent: "Con open",
        prUrl: "https://github.com/o/r/pull/1",
        prState: "open",
      });
      fake.addTask(project.id, { ...completed, intent: "Con merged", prState: "merged" });
      fake.addTask(project.id, { ...completed, intent: "Con closed", prState: "closed" });
      fake.addTask(project.id, { ...completed, intent: "Sin PR ni resultado", prState: null });
      fake.addTask(project.id, {
        ...completed,
        intent: "Investigar la cola",
        resultKind: "research",
        result: "# Hallazgos",
      });
      return fake;
    }

    function seedMany(restCount: number, openCount = 0) {
      const fake = new FakeApi();
      const project = fake.addProject({ name: "uno" });
      for (let i = 1; i <= openCount; i++) {
        fake.addTask(project.id, {
          ...completed,
          intent: `Abierta ${String(i).padStart(2, "0")}`,
          prUrl: `https://github.com/o/r/pull/${i}`,
          prState: "open",
        });
      }
      for (let i = 1; i <= restCount; i++) {
        fake.addTask(project.id, {
          ...completed,
          intent: `Resto ${String(i).padStart(2, "0")}`,
          prState: "merged",
        });
      }
      return fake;
    }

    it("AC-1: la primera lista solo tiene el PR open y la segunda todo lo demás", async () => {
      renderApp("/completed", seedMixed());

      await screen.findByText("Con open");
      expect(openList().getByText("Con open")).toBeTruthy();
      for (const intent of [
        "Con merged",
        "Con closed",
        "Sin PR ni resultado",
        "Investigar la cola",
      ]) {
        expect(openList().queryByText(intent)).toBeNull();
        expect(within(rest()).getByText(intent)).toBeTruthy();
      }
      expect(within(rest()).queryByText("Con open")).toBeNull();
    });

    it("AC-2: la sección del resto arranca colapsada y la primera lista está visible", async () => {
      renderApp("/completed", seedMixed());

      await screen.findByText("Con open");
      expect(rest().open).toBe(false);
      expect(openList().getByText("Con open")).toBeTruthy();
      expect(screen.getByRole("region", { name: "Con PR abierto" }).closest("details")).toBeNull();
    });

    it("AC-3: un clic en el encabezado expande la sección y otro la colapsa", async () => {
      const { user } = renderApp("/completed", seedMixed());

      await screen.findByText("Con open");
      await user.click(restSummary());
      expect(rest().open).toBe(true);
      expect(within(rest()).getByText("Con merged")).toBeTruthy();
      await user.click(restSummary());
      expect(rest().open).toBe(false);
    });

    it("AC-4: la tarea con Resultado y sin PR muestra su tipo y ningún enlace de PR", async () => {
      const { user } = renderApp("/completed", seedMixed());

      await screen.findByText("Con open");
      await user.click(restSummary());
      const row = within(within(rest()).getByRole("row", { name: /Investigar la cola/ }));
      expect(row.getByText("Investigación")).toBeTruthy();
      expect(row.queryByRole("link", { name: /^PR / })).toBeNull();
    });

    it("AC-5: una tarea in_progress con prState open no aparece en ninguna lista", async () => {
      const fake = seedMixed();
      fake.addTask(fake.addProject({ name: "otro" }).id, {
        intent: "En curso con PR",
        state: "in_progress",
        subState: "running",
        prState: "open",
      });
      renderApp("/completed", fake);

      await screen.findByText("Con open");
      expect(screen.queryByText("En curso con PR")).toBeNull();
    });

    it("AC-6: filtrar por proyecto limita ambas listas a ese proyecto", async () => {
      const fake = new FakeApi();
      const one = fake.addProject({ name: "uno" });
      const two = fake.addProject({ name: "dos" });
      fake.addTask(one.id, { ...completed, intent: "Open de uno", prState: "open" });
      fake.addTask(one.id, { ...completed, intent: "Merged de uno", prState: "merged" });
      fake.addTask(two.id, { ...completed, intent: "Open de dos", prState: "open" });
      fake.addTask(two.id, { ...completed, intent: "Merged de dos", prState: "merged" });
      const { user } = renderApp("/completed", fake);

      await screen.findByText("Open de dos");
      await user.selectOptions(screen.getByLabelText("Proyecto"), one.id);

      await waitFor(() => expect(screen.queryByText("Open de dos")).toBeNull());
      expect(screen.queryByText("Merged de dos")).toBeNull();
      expect(openList().getByText("Open de uno")).toBeTruthy();
      expect(within(rest()).getByText("Merged de uno")).toBeTruthy();
    });

    it("AC-7: elegir merged vacía la primera lista y deja solo la merged en la segunda", async () => {
      const { user } = renderApp("/completed", seedMixed());

      await screen.findByText("Con open");
      await user.selectOptions(screen.getByLabelText("Estado del PR"), "merged");

      await waitFor(() => expect(screen.queryByText("Con open")).toBeNull());
      expect(openList().getByText("No hay tareas completadas con PR abierto.")).toBeTruthy();
      expect(within(rest()).getByText("Con merged")).toBeTruthy();
      expect(within(rest()).queryByText("Con closed")).toBeNull();
      expect(within(rest()).queryByText("Sin PR ni resultado")).toBeNull();
    });

    it("AC-8: sin PR abiertos la primera lista tiene su estado vacío y el resto sigue colapsado", async () => {
      const fake = new FakeApi();
      fake.addTask(fake.addProject().id, { ...completed, intent: "Mergeada", prState: "merged" });
      renderApp("/completed", fake);

      await screen.findByText("Mergeada");
      expect(openList().getByText("No hay tareas completadas con PR abierto.")).toBeTruthy();
      expect(rest().open).toBe(false);
    });

    it("AC-9: la fila con PR open conserva enlace al detalle, proyecto y botón «PR open»", async () => {
      const fake = new FakeApi();
      const project = fake.addProject({ name: "uno" });
      const task = fake.addTask(project.id, {
        ...completed,
        intent: "Con open",
        prUrl: "https://github.com/o/r/pull/1",
        prState: "open",
      });
      renderApp("/completed", fake);

      const row = within(await screen.findByRole("row", { name: /Con open/ }));
      expect(row.getByRole("link", { name: "Con open" }).getAttribute("href")).toContain(
        `/tasks/${task.id}`,
      );
      expect(row.getByText("uno")).toBeTruthy();
      const pr = row.getByRole("link", { name: "PR open" });
      expect(pr.getAttribute("href")).toBe("https://github.com/o/r/pull/1");
      expect(pr.getAttribute("target")).toBe("_blank");
    });

    it("AC-10: 45 tareas en el resto se paginan de 20 en 20", async () => {
      const { user } = renderApp("/completed", seedMany(45));

      await screen.findByText("Resto 01");
      await user.click(restSummary());
      expect(within(rest()).getAllByRole("row")).toHaveLength(21);
      expect(within(rest()).getByText("Resto 20")).toBeTruthy();
      expect(within(rest()).queryByText("Resto 21")).toBeNull();
      expect(within(rest()).getByText("Página 1 de 3")).toBeTruthy();

      await user.click(within(rest()).getByRole("button", { name: "Siguiente" }));
      expect(within(rest()).getByText("Resto 21")).toBeTruthy();
      expect(within(rest()).getByText("Resto 40")).toBeTruthy();
      expect(within(rest()).queryByText("Resto 41")).toBeNull();

      await user.click(within(rest()).getByRole("button", { name: "Siguiente" }));
      expect(within(rest()).getAllByRole("row")).toHaveLength(6);
      expect(within(rest()).getByText("Resto 45")).toBeTruthy();
      expect(within(rest()).getByText("Página 3 de 3")).toBeTruthy();
      expect(
        (within(rest()).getByRole("button", { name: "Siguiente" }) as HTMLButtonElement).disabled,
      ).toBe(true);
    });

    it("AC-11: con 20 o menos tareas en el resto no hay controles de paginación", async () => {
      const { user } = renderApp("/completed", seedMany(20));

      await screen.findByText("Resto 01");
      await user.click(restSummary());
      expect(within(rest()).getAllByRole("row")).toHaveLength(21);
      expect(within(rest()).queryByRole("navigation", { name: "Paginación" })).toBeNull();
    });

    it("AC-12: cambiar un filtro desde la página 3 vuelve a la página 1", async () => {
      const fake = seedMany(45);
      const second = fake.addProject({ name: "dos" });
      for (let i = 1; i <= 25; i++) {
        fake.addTask(second.id, {
          ...completed,
          intent: `Dos ${String(i).padStart(2, "0")}`,
          prState: "closed",
        });
      }
      const { user } = renderApp("/completed", fake);

      await screen.findByText("Resto 01");
      await user.click(restSummary());
      const next = () => within(rest()).getByRole("button", { name: "Siguiente" });
      await user.click(next());
      await user.click(next());
      await user.click(next());
      expect(within(rest()).getByText("Página 4 de 4")).toBeTruthy();

      await user.selectOptions(screen.getByLabelText("Estado del PR"), "closed");
      await waitFor(() => expect(within(rest()).getByText("Página 1 de 2")).toBeTruthy());
      expect(within(rest()).getByText("Dos 01")).toBeTruthy();

      await user.click(within(rest()).getByRole("button", { name: "Siguiente" }));
      expect(within(rest()).getByText("Página 2 de 2")).toBeTruthy();
      await user.selectOptions(screen.getByLabelText("Proyecto"), second.id);
      await waitFor(() => expect(within(rest()).getByText("Página 1 de 2")).toBeTruthy());
    });

    it("AC-13: la primera lista no se pagina aunque haya más de 20 PR abiertos", async () => {
      const { user } = renderApp("/completed", seedMany(30, 25));

      await screen.findByText("Abierta 01");
      expect(openList().getAllByRole("row")).toHaveLength(26);
      expect(openList().queryByRole("navigation", { name: "Paginación" })).toBeNull();
      await user.click(restSummary());
      expect(within(rest()).getByText("Página 1 de 2")).toBeTruthy();
      expect(within(rest()).getAllByRole("row")).toHaveLength(21);
    });
  });
});
