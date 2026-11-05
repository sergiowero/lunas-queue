import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FakeApi } from "../../test/fake-api.ts";
import { renderApp } from "../../test/render.tsx";
import { buttonVariants } from "../components/ui/button.tsx";

describe("Completed tab", () => {
  it("links from the navigation and lists completed tasks of all projects", async () => {
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

  it("filters completed tasks by project and shows the empty state", async () => {
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

  it("AC-10: filtering by Sin PR, the task with a Result shows its type instead of a PR", async () => {
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

  describe("PR state filter", () => {
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

    it("starts at Todos and offers Todos, open, merged, closed and Sin PR", async () => {
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

    it("shows only the tasks with the chosen PR state", async () => {
      const { user } = renderApp("/completed", seedAllStates());

      await screen.findByText("Con open");
      await user.selectOptions(screen.getByLabelText("Estado del PR"), "merged");

      await waitFor(() => expect(screen.queryByText("Con open")).toBeNull());
      expect(screen.getByText("Con merged")).toBeTruthy();
      expect(screen.queryByText("Con closed")).toBeNull();
      expect(screen.queryByText("Sin ningún PR")).toBeNull();
    });

    it("Sin PR shows only completed tasks without a PR state", async () => {
      const { user } = renderApp("/completed", seedAllStates());

      await screen.findByText("Con merged");
      await user.selectOptions(screen.getByLabelText("Estado del PR"), "Sin PR");

      await waitFor(() => expect(screen.queryByText("Con merged")).toBeNull());
      expect(screen.getByText("Sin ningún PR")).toBeTruthy();
      expect(screen.queryByText("Con open")).toBeNull();
    });

    it("going back to Todos shows all completed tasks again", async () => {
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

    it("it combines with the project filter", async () => {
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

    it("never shows tasks that are not completed and falls back to the empty state", async () => {
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

  it("explains when there are no completed tasks", async () => {
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

  it("shows the PR as a small outline button that opens in another tab", async () => {
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

  it("the PR button carries a decorative external link icon", async () => {
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

  it("without prUrl the PR cell is text, without link or icon", async () => {
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

  describe("two lists: open PR and a collapsible rest", () => {
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

    it("AC-1: the first list only has the open PR and the second everything else", async () => {
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

    it("AC-2: the rest section starts collapsed and the first list is visible", async () => {
      renderApp("/completed", seedMixed());

      await screen.findByText("Con open");
      expect(rest().open).toBe(false);
      expect(openList().getByText("Con open")).toBeTruthy();
      expect(screen.getByRole("region", { name: "Con PR abierto" }).closest("details")).toBeNull();
    });

    it("AC-3: a click on the heading expands the section and another collapses it", async () => {
      const { user } = renderApp("/completed", seedMixed());

      await screen.findByText("Con open");
      await user.click(restSummary());
      expect(rest().open).toBe(true);
      expect(within(rest()).getByText("Con merged")).toBeTruthy();
      await user.click(restSummary());
      expect(rest().open).toBe(false);
    });

    it("AC-4: the task with a Result and without a PR shows its type and no PR link", async () => {
      const { user } = renderApp("/completed", seedMixed());

      await screen.findByText("Con open");
      await user.click(restSummary());
      const row = within(within(rest()).getByRole("row", { name: /Investigar la cola/ }));
      expect(row.getByText("Investigación")).toBeTruthy();
      expect(row.queryByRole("link", { name: /^PR / })).toBeNull();
    });

    it("AC-5: an in_progress task with prState open appears in neither list", async () => {
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

    it("AC-6: filtering by project limits both lists to that project", async () => {
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

    it("AC-7: choosing merged empties the first list and leaves only the merged one in the second", async () => {
      const { user } = renderApp("/completed", seedMixed());

      await screen.findByText("Con open");
      await user.selectOptions(screen.getByLabelText("Estado del PR"), "merged");

      await waitFor(() => expect(screen.queryByText("Con open")).toBeNull());
      expect(openList().getByText("No hay tareas completadas con PR abierto.")).toBeTruthy();
      expect(within(rest()).getByText("Con merged")).toBeTruthy();
      expect(within(rest()).queryByText("Con closed")).toBeNull();
      expect(within(rest()).queryByText("Sin PR ni resultado")).toBeNull();
    });

    it("AC-8: without open PRs the first list has its empty state and the rest stays collapsed", async () => {
      const fake = new FakeApi();
      fake.addTask(fake.addProject().id, { ...completed, intent: "Mergeada", prState: "merged" });
      renderApp("/completed", fake);

      await screen.findByText("Mergeada");
      expect(openList().getByText("No hay tareas completadas con PR abierto.")).toBeTruthy();
      expect(rest().open).toBe(false);
    });

    it("AC-9: the row with an open PR keeps its link to the detail, project and «PR open» button", async () => {
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

    it("AC-10: 45 tasks in the rest are paginated 20 at a time", async () => {
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

    it("AC-11: with 20 or fewer tasks in the rest there are no pagination controls", async () => {
      const { user } = renderApp("/completed", seedMany(20));

      await screen.findByText("Resto 01");
      await user.click(restSummary());
      expect(within(rest()).getAllByRole("row")).toHaveLength(21);
      expect(within(rest()).queryByRole("navigation", { name: "Paginación" })).toBeNull();
    });

    it("AC-12: changing a filter from page 3 goes back to page 1", async () => {
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

    it("AC-13: the first list is not paginated even with more than 20 open PRs", async () => {
      const { user } = renderApp("/completed", seedMany(30, 25));

      await screen.findByText("Abierta 01");
      expect(openList().getAllByRole("row")).toHaveLength(26);
      expect(openList().queryByRole("navigation", { name: "Paginación" })).toBeNull();
      await user.click(restSummary());
      expect(within(rest()).getByText("Página 1 de 2")).toBeTruthy();
      expect(within(rest()).getAllByRole("row")).toHaveLength(21);
    });
  });

  describe("filters across navigation", () => {
    const completed = { state: "completed", subState: null } as const;

    it("keeps project and PR state when the user goes to another tab and comes back", async () => {
      const fake = new FakeApi();
      const one = fake.addProject({ name: "uno" });
      const two = fake.addProject({ name: "dos" });
      fake.addTask(one.id, { ...completed, intent: "Merged de uno", prState: "merged" });
      fake.addTask(two.id, { ...completed, intent: "Merged de dos", prState: "merged" });
      fake.addTask(one.id, { ...completed, intent: "Open de uno", prState: "open" });
      const { user, router } = renderApp("/completed", fake);
      await screen.findByText("Merged de dos");
      await user.selectOptions(screen.getByLabelText("Proyecto"), one.id);
      await user.selectOptions(screen.getByLabelText("Estado del PR"), "merged");
      await waitFor(() => expect(screen.queryByText("Merged de dos")).toBeNull());

      await router.navigate({ to: "/in-progress" });
      await screen.findByRole("heading", { name: "En curso" });
      await router.navigate({ to: "/completed" });

      await screen.findByText("Merged de uno");
      expect((screen.getByLabelText("Proyecto") as HTMLSelectElement).value).toBe(one.id);
      expect((screen.getByLabelText("Estado del PR") as HTMLSelectElement).value).toBe("merged");
      expect(screen.queryByText("Merged de dos")).toBeNull();
      expect(screen.queryByText("Open de uno")).toBeNull();
    });
  });
});
