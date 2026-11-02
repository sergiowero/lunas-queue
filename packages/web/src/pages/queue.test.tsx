import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FakeApi } from "../../test/fake-api.ts";
import { renderApp } from "../../test/render.tsx";

describe("global queue", () => {
  it("shows the tasks in the server order, with score, state, project and usage", async () => {
    const fake = new FakeApi();
    const project = fake.addProject({ name: "lunas-queue" });
    const a = fake.addTask(project.id, { intent: "Primera", priority: 10 });
    const b = fake.addTask(project.id, { intent: "Segunda", priority: 5 });
    const running = fake.addTask(project.id, { intent: "Corriendo", subState: "running" });
    const usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 };
    fake.queue = [
      {
        task: b,
        ready: true,
        score: 42.5,
        effectivePriority: 30,
        usage: { ...usage, costUsd: 1.5 },
      },
      {
        task: a,
        ready: true,
        score: 10,
        effectivePriority: 10,
        usage: { ...usage, costUsd: null },
      },
      {
        task: running,
        ready: false,
        score: null,
        effectivePriority: null,
        usage: { ...usage, costUsd: null },
      },
    ];
    renderApp("/queue", fake);

    const rows = await screen.findAllByRole("row");
    const body = rows.slice(1).map((row) => within(row).getAllByRole("cell"));
    // The task cell carries its #N before the intent.
    expect(body.map((cells) => cells[1]?.textContent)).toEqual([
      `#${b.number}Segunda`,
      `#${a.number}Primera`,
      `#${running.number}Corriendo`,
    ]);
    expect(body[0]?.map((c) => c.textContent)).toEqual([
      "1",
      `#${b.number}Segunda`,
      "lunas-queue",
      "Draften cola",
      "5 → 30",
      "42.5",
      "120 · $1,50",
      "",
    ]);
    expect(body[2]?.[5]?.textContent).toBe("—");
    expect(within(rows[1] as HTMLElement).getByRole("link", { name: "Segunda" })).toHaveProperty(
      "href",
      expect.stringContaining(`/tasks/${b.id}`),
    );
  });

  it("the Estado column shows a label per task, blue only for In progress", async () => {
    const fake = new FakeApi();
    const project = fake.addProject();
    fake.addTask(project.id, { intent: "Borrador" });
    fake.addTask(project.id, { intent: "Verificando", state: "verification", subState: "running" });
    fake.addTask(project.id, { intent: "Bloqueada", state: "needs_human", subState: null });
    fake.addTask(project.id, { intent: "Trabajando", state: "in_progress", subState: "running" });
    fake.queue = fake.tasks.map((task) => ({
      task,
      ready: false,
      score: null,
      effectivePriority: null,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: null,
      },
    }));
    renderApp("/queue", fake);

    const row = async (intent: string) =>
      within((await screen.findByRole("link", { name: intent })).closest("tr") as HTMLElement);
    const variant = async (intent: string, label: string) =>
      (await row(intent)).getByText(label).dataset.variant;
    expect(await variant("Trabajando", "In progress")).toBe("info");
    expect(await variant("Borrador", "Draft")).toBe("secondary");
    expect(await variant("Verificando", "Verification")).toBe("secondary");
    expect(await variant("Bloqueada", "Needs human")).toBe("destructive");
    expect(screen.getAllByText("In progress")).toHaveLength(1);
  });

  describe("Acciones column", () => {
    const queueOf = (fake: FakeApi) => {
      fake.queue = fake.tasks.map((task) => ({
        task,
        ready: false,
        score: null,
        effectivePriority: null,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: null,
        },
      }));
    };
    const rowOf = async (intent: string) =>
      within((await screen.findByRole("link", { name: intent })).closest("tr") as HTMLElement);

    it("the pausable one carries only the pause icon; the paused one and the needs_human one only the resume icon", async () => {
      const fake = new FakeApi();
      const project = fake.addProject();
      fake.addTask(project.id, { intent: "Pausable", state: "in_progress", subState: "running" });
      fake.addTask(project.id, { intent: "Pausada", state: "paused", subState: null });
      fake.addTask(project.id, { intent: "Escalada", state: "needs_human", subState: null });
      queueOf(fake);
      renderApp("/queue", fake);

      expect((await screen.findAllByRole("columnheader")).map((h) => h.textContent).at(-1)).toBe(
        "Acciones",
      );
      const actions = async (intent: string) => {
        const cells = (await rowOf(intent)).getAllByRole("cell");
        return cells[cells.length - 1] as HTMLElement;
      };

      const pausable = within(await actions("Pausable"));
      const pause = pausable.getByRole("button", { name: "Pausar tarea Pausable" });
      expect(pause.textContent).toBe("");
      expect(pause.querySelector('svg[data-icon="pause"]')).not.toBeNull();
      expect(pausable.getAllByRole("button")).toHaveLength(1);

      for (const intent of ["Pausada", "Escalada"]) {
        const cell = within(await actions(intent));
        const resume = cell.getByRole("button", { name: `Reanudar tarea ${intent}` });
        expect(resume.textContent).toBe("");
        expect(resume.querySelector('svg[data-icon="resume"]')).not.toBeNull();
        expect(cell.getAllByRole("button")).toHaveLength(1);
      }
    });

    it("pausing from the Cola moves the task to Paused and offers to resume it", async () => {
      const fake = new FakeApi();
      const project = fake.addProject();
      const task = fake.addTask(project.id, {
        intent: "Se pausa",
        state: "refined",
        subState: null,
      });
      const { user } = renderApp("/queue", fake);

      await user.click(await screen.findByRole("button", { name: "Pausar tarea Se pausa" }));

      expect(await screen.findByRole("button", { name: "Reanudar tarea Se pausa" })).toBeTruthy();
      expect(fake.task(task.id).state).toBe("paused");
      expect(screen.getByText("Paused")).toBeTruthy();

      await user.click(screen.getByRole("button", { name: "Reanudar tarea Se pausa" }));

      expect(await screen.findByRole("button", { name: "Pausar tarea Se pausa" })).toBeTruthy();
      expect(fake.task(task.id).state).toBe("refined");
    });

    it("if the API rejects the action it shows the error with role alert in that row", async () => {
      const fake = new FakeApi();
      const project = fake.addProject();
      const task = fake.addTask(project.id, { intent: "Rechazada", state: "draft" });
      fake.addTask(project.id, { intent: "Intacta", state: "draft" });
      const { user } = renderApp("/queue", fake);
      const button = await screen.findByRole("button", { name: "Pausar tarea Rechazada" });
      fake.task(task.id).state = "completed";

      await user.click(button);

      expect((await (await rowOf("Rechazada")).findByRole("alert")).textContent).toMatch(
        /pause does not apply/,
      );
      expect((await rowOf("Intacta")).queryByRole("alert")).toBeNull();
    });
  });

  it("filters by project", async () => {
    const fake = new FakeApi();
    const one = fake.addProject({ name: "uno" });
    const two = fake.addProject({ name: "dos" });
    fake.addTask(one.id, { intent: "De uno" });
    fake.addTask(two.id, { intent: "De dos" });
    const { user } = renderApp("/queue", fake);

    await screen.findByText("De dos");
    await user.selectOptions(screen.getByLabelText("Proyecto"), "uno");
    await waitFor(() => expect(screen.queryByText("De dos")).toBeNull());
    expect(screen.getByText("De uno")).toBeTruthy();
    expect(fake.requests.at(-1)?.path).toBe(`/api/queue?projectId=${one.id}`);
  });

  it("explains when the queue is empty", async () => {
    renderApp("/queue");
    expect(await screen.findByText("No hay tareas vivas en la cola.")).toBeTruthy();
  });

  describe("filters across navigation", () => {
    function twoProjects() {
      const fake = new FakeApi();
      const one = fake.addProject({ name: "uno" });
      const two = fake.addProject({ name: "dos" });
      fake.addTask(one.id, { intent: "De uno" });
      fake.addTask(two.id, { intent: "De dos" });
      return { fake, one, two };
    }

    it("keeps the project when the user goes to another tab and comes back", async () => {
      const { fake, one } = twoProjects();
      const { user, router } = renderApp("/queue", fake);
      await screen.findByText("De dos");
      await user.selectOptions(screen.getByLabelText("Proyecto"), "uno");
      await waitFor(() => expect(screen.queryByText("De dos")).toBeNull());

      await router.navigate({ to: "/in-progress" });
      await screen.findByRole("heading", { name: "En curso" });
      await router.navigate({ to: "/queue" });

      await screen.findByText("De uno");
      expect((screen.getByLabelText("Proyecto") as HTMLSelectElement).value).toBe(one.id);
      expect(screen.queryByText("De dos")).toBeNull();
    });

    it("does not leak a tab's filters into the other tabs, and each tab restores its own", async () => {
      const { fake, one, two } = twoProjects();
      const completed = { state: "completed", subState: null } as const;
      fake.addTask(one.id, {
        intent: "Ejecutando de uno",
        state: "in_progress",
        subState: "running",
      });
      fake.addTask(two.id, {
        intent: "Ejecutando de dos",
        state: "in_progress",
        subState: "queued",
      });
      fake.addTask(one.id, { ...completed, intent: "Merged de uno", prState: "merged" });
      fake.addTask(two.id, { ...completed, intent: "Merged de dos", prState: "merged" });
      fake.addTask(two.id, { ...completed, intent: "Open de dos", prState: "open" });
      const { user, router } = renderApp("/queue", fake);
      const project = () => screen.getByLabelText("Proyecto") as HTMLSelectElement;
      const prState = () => screen.getByLabelText("Estado del PR") as HTMLSelectElement;

      // Queue: project "uno".
      await screen.findByText("De dos");
      await user.selectOptions(project(), "uno");
      await waitFor(() => expect(screen.queryByText("De dos")).toBeNull());

      // In progress opens for the first time on All; pick "dos" there.
      await router.navigate({ to: "/in-progress" });
      await screen.findByRole("heading", { name: "En curso" });
      await screen.findByText("Ejecutando de uno");
      expect(project().value).toBe("");
      expect(screen.getByText("Ejecutando de dos")).toBeTruthy();
      await user.selectOptions(project(), "dos");
      await waitFor(() => expect(screen.queryByText("Ejecutando de uno")).toBeNull());

      // Completed opens for the first time on All / any PR state; pick "dos" and "merged".
      await router.navigate({ to: "/completed" });
      await screen.findByRole("heading", { name: "Completed" });
      await screen.findByText("Merged de uno");
      expect(project().value).toBe("");
      expect(prState().value).toBe("");
      expect(screen.getByText("Open de dos")).toBeTruthy();
      await user.selectOptions(project(), "dos");
      await user.selectOptions(prState(), "merged");
      await waitFor(() => expect(screen.queryByText("Merged de uno")).toBeNull());
      expect(screen.queryByText("Open de dos")).toBeNull();

      // Back to Queue: still "uno" only.
      await router.navigate({ to: "/queue" });
      await screen.findByText("De uno");
      expect(project().value).toBe(one.id);
      expect(screen.queryByText("De dos")).toBeNull();

      // Back to In progress: still "dos" only.
      await router.navigate({ to: "/in-progress" });
      await screen.findByText("Ejecutando de dos");
      expect(project().value).toBe(two.id);
      expect(screen.queryByText("Ejecutando de uno")).toBeNull();

      // Back to Completed: still "dos" + "merged".
      await router.navigate({ to: "/completed" });
      await screen.findByText("Merged de dos");
      expect(project().value).toBe(two.id);
      expect(prState().value).toBe("merged");
      expect(screen.queryByText("Merged de uno")).toBeNull();
      expect(screen.queryByText("Open de dos")).toBeNull();
    });

    it("keeps the project after opening a task detail and going back", async () => {
      const { fake, one } = twoProjects();
      const { user, router } = renderApp("/queue", fake);
      await screen.findByText("De dos");
      await user.selectOptions(screen.getByLabelText("Proyecto"), "uno");
      await user.click(await screen.findByRole("link", { name: "De uno" }));
      await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/tasks\//));

      router.history.back();

      await screen.findByText("De uno");
      expect((screen.getByLabelText("Proyecto") as HTMLSelectElement).value).toBe(one.id);
      expect(screen.queryByText("De dos")).toBeNull();
    });

    it("starts with every filter on All in each of the three tabs of a fresh app", async () => {
      const { fake } = twoProjects();
      const completed = { state: "completed", subState: null } as const;
      fake.addTask(fake.projects[0]?.id as string, {
        intent: "Ejecutando de uno",
        state: "in_progress",
        subState: "running",
      });
      fake.addTask(fake.projects[1]?.id as string, {
        intent: "Ejecutando de dos",
        state: "in_progress",
        subState: "queued",
      });
      fake.addTask(fake.projects[0]?.id as string, {
        ...completed,
        intent: "Merged de uno",
        prState: "merged",
      });
      fake.addTask(fake.projects[1]?.id as string, {
        ...completed,
        intent: "Open de dos",
        prState: "open",
      });
      const { router, user, unmount } = renderApp("/queue", fake);
      const project = () => screen.getByLabelText("Proyecto") as HTMLSelectElement;

      await screen.findByText("De dos");
      expect(project().value).toBe("");
      expect(screen.getByText("De uno")).toBeTruthy();

      await router.navigate({ to: "/in-progress" });
      await screen.findByText("Ejecutando de uno");
      expect(project().value).toBe("");
      expect(screen.getByText("Ejecutando de dos")).toBeTruthy();

      await router.navigate({ to: "/completed" });
      await screen.findByText("Merged de uno");
      expect(project().value).toBe("");
      expect((screen.getByLabelText("Estado del PR") as HTMLSelectElement).value).toBe("");
      expect(screen.getByText("Open de dos")).toBeTruthy();

      // The store belongs to the app instance: filters chosen here must not reach a fresh app
      // (guards against a module-level store that would outlive the instance).
      await user.selectOptions(project(), fake.projects[0]?.id as string);
      await user.selectOptions(screen.getByLabelText("Estado del PR"), "merged");
      await router.navigate({ to: "/queue" });
      await screen.findByText("De uno");
      await router.navigate({ to: "/completed" });
      await screen.findByText("Merged de uno");
      // Chosen filters are really held by this instance (a stateless store would show All here) ...
      expect(project().value).toBe(fake.projects[0]?.id);
      expect((screen.getByLabelText("Estado del PR") as HTMLSelectElement).value).toBe("merged");
      unmount();

      // ... and still a fresh instance starts on All.
      renderApp("/completed", fake);
      await screen.findByText("Open de dos");
      expect(project().value).toBe("");
      expect((screen.getByLabelText("Estado del PR") as HTMLSelectElement).value).toBe("");
      expect(screen.getByText("Merged de uno")).toBeTruthy();
    });

    it("falls back to All when the stored project was removed", async () => {
      const { fake } = twoProjects();
      const empty = fake.addProject({ name: "vacío" });
      const { user, router, queryClient } = renderApp("/queue", fake);
      await screen.findByText("De dos");
      await user.selectOptions(screen.getByLabelText("Proyecto"), "vacío");
      await router.navigate({ to: "/in-progress" });
      await screen.findByRole("heading", { name: "En curso" });

      fake.projects.splice(fake.projects.indexOf(empty), 1);
      fake.requests.length = 0;
      await router.navigate({ to: "/queue" });

      // The filter is still stored on return (the cached project list still has it) ...
      await waitFor(() =>
        expect(fake.requests.map((r) => r.path)).toContain(`/api/queue?projectId=${empty.id}`),
      );
      // ... and falls back to All once the refreshed list no longer has the project.
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      await screen.findByText("De dos");
      expect((screen.getByLabelText("Proyecto") as HTMLSelectElement).value).toBe("");
      expect(screen.getByText("De uno")).toBeTruthy();
      expect(fake.requests.at(-1)?.path).toBe("/api/queue");

      // The stored id was cleared: the project does not come back if it reappears in the list.
      fake.projects.push(empty);
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      await waitFor(() =>
        expect(
          Array.from((screen.getByLabelText("Proyecto") as HTMLSelectElement).options).map(
            (o) => o.value,
          ),
        ).toContain(empty.id),
      );
      expect((screen.getByLabelText("Proyecto") as HTMLSelectElement).value).toBe("");
      expect(
        fake.requests
          .map((r) => r.path)
          .filter((path) => path.startsWith("/api/queue"))
          .at(-1),
      ).toBe("/api/queue");
    });
  });
});
