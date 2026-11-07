import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FakeApi } from "../../test/fake-api.ts";
import { renderApp } from "../../test/render.tsx";
import { queries } from "../lib/queries.ts";

describe("In progress tab", () => {
  it("the En curso nav link leads to /in-progress and becomes active", async () => {
    const { user, router } = renderApp("/queue");
    const nav = within(await screen.findByRole("navigation"));
    const link = nav.getByRole("link", { name: "En curso" });
    expect(link.getAttribute("href")).toBe("/in-progress");
    expect(link.className).not.toContain("bg-primary/10");

    await user.click(link);
    await waitFor(() => expect(router.state.location.pathname).toBe("/in-progress"));
    expect(nav.getByRole("link", { name: "En curso" }).className).toContain("bg-primary/10");
    expect(await screen.findByRole("heading", { name: "En curso" })).toBeTruthy();
  });

  it("lists the In progress tasks and those with a running agent, with project, state and priority", async () => {
    const fake = new FakeApi();
    const one = fake.addProject({ name: "uno" });
    const two = fake.addProject({ name: "dos" });
    fake.addTask(one.id, { goal: "Borrador" });
    const verifying = fake.addTask(one.id, {
      goal: "Verificando",
      state: "verification",
      subState: "running",
    });
    fake.addTask(two.id, {
      goal: "Verificando en espera",
      state: "verification",
      subState: "waiting_human",
    });
    fake.addTask(two.id, { goal: "Terminada", state: "completed", subState: null });
    const running = fake.addTask(one.id, {
      goal: "Corriendo en uno",
      state: "in_progress",
      subState: "running",
      priority: 300,
    });
    const waiting = fake.addTask(two.id, {
      goal: "Esperando en dos",
      state: "in_progress",
      subState: "waiting_human",
      priority: 50,
    });
    renderApp("/in-progress", fake);

    const link = await screen.findByRole("link", { name: "Corriendo en uno" });
    expect(link.getAttribute("href")).toBe(`/tasks/${running.id}`);
    await waitFor(() => expect(screen.queryAllByText("…")).toHaveLength(0));
    const rows = screen.getAllByRole("row").slice(1);
    // Without the Acciones column, which is tested separately.
    const cells = rows.map((r) =>
      within(r)
        .getAllByRole("cell")
        .slice(0, -1)
        .map((c) => c.textContent),
    );
    expect(cells).toContainEqual([
      `#${running.number}Corriendo en uno`,
      "uno",
      "In progresscorriendo",
      "300",
      "—",
      "—",
      "—",
    ]);
    expect(cells).toContainEqual([
      `#${waiting.number}Esperando en dos`,
      "dos",
      "In progressesperando humano",
      "50",
      "—",
      "—",
      "—",
    ]);
    expect(cells.map((c) => c[0])).toContain(`#${verifying.number}Verificando`);
    expect(cells).toHaveLength(3);
    expect(screen.queryByText("Borrador")).toBeNull();
    expect(screen.queryByText("Verificando en espera")).toBeNull();
    expect(screen.queryByText("Terminada")).toBeNull();
  });

  it("the Estado column shows the task's state (not just the sub-state), like the Cola tab", async () => {
    const fake = new FakeApi();
    const project = fake.addProject();
    fake.addTask(project.id, { goal: "Refinando", state: "draft", subState: "running" });
    fake.addTask(project.id, {
      goal: "Implementando",
      state: "in_progress",
      subState: "waiting_human",
    });
    fake.addTask(project.id, {
      goal: "Verificando",
      state: "verification",
      subState: "running",
    });
    renderApp("/in-progress", fake);

    await screen.findByRole("link", { name: "Refinando" });
    await waitFor(() => expect(screen.queryAllByText("…")).toHaveLength(0));
    const stateCell = (goal: string) =>
      within(screen.getByRole("link", { name: goal }).closest("tr") as HTMLElement).getAllByRole(
        "cell",
      )[2] as HTMLElement;
    expect(within(stateCell("Refinando")).getByText("Draft")).toBeTruthy();
    expect(stateCell("Refinando").textContent).toBe("Draftcorriendo");
    expect(within(stateCell("Implementando")).getByText("In progress")).toBeTruthy();
    expect(stateCell("Implementando").textContent).toBe("In progressesperando humano");
    expect(within(stateCell("Verificando")).getByText("Verification")).toBeTruthy();
    expect(stateCell("Verificando").textContent).toBe("Verificationcorriendo");
  });

  it("a task's Estado cell is identical in En curso and in Cola", async () => {
    const fake = new FakeApi();
    const project = fake.addProject();
    fake.addTask(project.id, { goal: "En ambas", state: "verification", subState: "running" });
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
    const { user, router } = renderApp("/queue", fake);
    const stateText = async () => {
      const row = (await screen.findByRole("link", { name: "En ambas" })).closest("tr");
      const header = screen
        .getAllByRole("columnheader")
        .findIndex((h) => h.textContent === "Estado");
      return within(row as HTMLElement).getAllByRole("cell")[header]?.textContent;
    };
    const inQueue = await stateText();

    await user.click(
      within(await screen.findByRole("navigation")).getByRole("link", { name: /^En curso/ }),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe("/in-progress"));
    await waitFor(() => expect(screen.queryAllByText("…")).toHaveLength(0));

    expect(inQueue).toBe("Verificationcorriendo");
    expect(await stateText()).toBe(inQueue);
  });

  describe("per-row pause button", () => {
    it("each row has a button with a pause icon and an accessible name with the task, without visible text", async () => {
      const fake = new FakeApi();
      const project = fake.addProject();
      fake.addTask(project.id, { goal: "Una", state: "in_progress", subState: "running" });
      fake.addTask(project.id, { goal: "Otra", state: "verification", subState: "running" });
      renderApp("/in-progress", fake);

      // The rows are remounted when the Runs arrive: wait for them to stop loading.
      await screen.findByRole("link", { name: "Una" });
      await waitFor(() => expect(screen.queryAllByText("…")).toHaveLength(0));
      for (const name of ["Una", "Otra"]) {
        const row = within(screen.getByRole("link", { name }).closest("tr") as HTMLElement);
        const button = row.getByRole("button", { name: `Pausar tarea ${name}` });
        expect(button.textContent).toBe("");
        expect(button.querySelector('svg[data-icon="pause"]')).not.toBeNull();
      }
    });

    it("on click the task is paused and stops appearing after refreshing", async () => {
      const fake = new FakeApi();
      const project = fake.addProject();
      const task = fake.addTask(project.id, {
        goal: "Se pausa",
        state: "in_progress",
        subState: "running",
      });
      fake.addTask(project.id, { goal: "Sigue", state: "in_progress", subState: "queued" });
      const { user } = renderApp("/in-progress", fake);

      await user.click(await screen.findByRole("button", { name: "Pausar tarea Se pausa" }));

      await waitFor(() => expect(screen.queryByRole("link", { name: "Se pausa" })).toBeNull());
      expect(fake.task(task.id).state).toBe("paused");
      expect(fake.requests.some((r) => r.path === `/api/tasks/${task.id}/pause`)).toBe(true);
      expect(screen.getByRole("link", { name: "Sigue" })).toBeTruthy();
    });

    it("if the API rejects the pause it shows the error with role alert in that row and the task stays", async () => {
      const fake = new FakeApi();
      const project = fake.addProject();
      const task = fake.addTask(project.id, {
        goal: "Rechazada",
        state: "in_progress",
        subState: "running",
      });
      fake.addTask(project.id, { goal: "Intacta", state: "in_progress", subState: "queued" });
      const { user } = renderApp("/in-progress", fake);
      const button = await screen.findByRole("button", { name: "Pausar tarea Rechazada" });
      // It left the pausable states while the list stayed open.
      fake.task(task.id).state = "needs_human";

      await user.click(button);

      const row = (text: string) =>
        within(screen.getByRole("link", { name: text }).closest("tr") as HTMLElement);
      expect((await row("Rechazada").findByRole("alert")).textContent).toMatch(
        /pause does not apply/,
      );
      expect(row("Intacta").queryByRole("alert")).toBeNull();
      expect(
        (screen.getByRole("button", { name: "Pausar tarea Rechazada" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    });
  });

  it("filters by project and Todos shows both again", async () => {
    const fake = new FakeApi();
    const one = fake.addProject({ name: "uno" });
    const two = fake.addProject({ name: "dos" });
    fake.addTask(one.id, { goal: "De uno", state: "in_progress", subState: "running" });
    fake.addTask(two.id, { goal: "De dos", state: "in_progress", subState: "queued" });
    const { user } = renderApp("/in-progress", fake);

    await screen.findByText("De dos");
    await user.selectOptions(screen.getByLabelText("Proyecto"), "uno");
    await waitFor(() => expect(screen.queryByText("De dos")).toBeNull());
    expect(screen.getByText("De uno")).toBeTruthy();

    await user.selectOptions(screen.getByLabelText("Proyecto"), "");
    expect(await screen.findByText("De dos")).toBeTruthy();
    expect(screen.getByText("De uno")).toBeTruthy();
  });

  it("explains there are no tasks in progress, without an empty table", async () => {
    const fake = new FakeApi();
    fake.addTask(fake.addProject().id, { goal: "Borrador" });
    renderApp("/in-progress", fake);

    expect(await screen.findByText("No hay tareas en curso.")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  describe("Iteración, Agente and Pane columns", () => {
    const rowOf = async (text: string) => {
      await screen.findByRole("link", { name: text });
      // The row is remounted when the columns change: it is looked up again on each read.
      const read = () =>
        within(screen.getByRole("link", { name: text }).closest("tr") as HTMLElement)
          .getAllByRole("cell")
          .slice(0, -1)
          .map((c) => c.textContent);
      await waitFor(() => expect(read()).not.toContain("…"));
      return read();
    };

    it("table headers: the existing ones, the three Run ones and Acciones at the end", async () => {
      const fake = new FakeApi();
      fake.addTask(fake.addProject().id, { goal: "Una", state: "in_progress" });
      renderApp("/in-progress", fake);

      await screen.findByRole("link", { name: "Una" });
      const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
      expect(headers).toEqual([
        "Tarea",
        "Proyecto",
        "Estado",
        "Prioridad",
        "Iteración",
        "Agente",
        "Pane",
        "Acciones",
      ]);
    });

    it("shows iteration, agent with model and pane of the open Run", async () => {
      const fake = new FakeApi();
      const task = fake.addTask(fake.addProject({ name: "uno" }).id, {
        goal: "Con run",
        state: "in_progress",
        subState: "running",
        priority: 10,
        verificationIteration: 1,
      });
      const run = fake.startRun(task.id, "implement");
      run.herdrPane = "p-7";
      renderApp("/in-progress", fake);

      expect(await rowOf("Con run")).toEqual([
        `#${task.number}Con run`,
        "uno",
        "In progresscorriendo",
        "10",
        "1",
        "claude · opus",
        "p-7",
      ]);
    });

    it("uses the most recent Run when there is an earlier finished one", async () => {
      const fake = new FakeApi();
      const task = fake.addTask(fake.addProject().id, {
        goal: "Dos runs",
        state: "in_progress",
        subState: "running",
      });
      const first = fake.startRun(task.id, "implement");
      first.herdrPane = "p-1";
      fake.endRun(first.id, {});
      const latest = fake.startRun(task.id, "implement");
      latest.herdrPane = "p-2";
      latest.iteration = 2;
      latest.model = "sonnet";
      renderApp("/in-progress", fake);

      const cells = await rowOf("Dos runs");
      expect(cells.slice(4)).toEqual(["2", "claude · sonnet", "p-2"]);
    });

    it("the most recent Run is decided by startedAt, not by the response order", async () => {
      const fake = new FakeApi();
      const task = fake.addTask(fake.addProject().id, {
        goal: "Desordenados",
        state: "in_progress",
      });
      const older = fake.startRun(task.id, "implement");
      older.herdrPane = "p-old";
      const newer = fake.startRun(task.id, "verify");
      newer.herdrPane = "p-new";
      fake.runs.reverse();
      renderApp("/in-progress", fake);

      const cells = await rowOf("Desordenados");
      expect(cells[6]).toBe("p-new");
    });

    it("without Runs, the three columns show «—» and the rest of the row is kept", async () => {
      const fake = new FakeApi();
      const task = fake.addTask(fake.addProject({ name: "uno" }).id, {
        goal: "Sin runs",
        state: "in_progress",
        subState: "queued",
        priority: 5,
      });
      renderApp("/in-progress", fake);

      expect(await rowOf("Sin runs")).toEqual([
        `#${task.number}Sin runs`,
        "uno",
        "In progressen cola",
        "5",
        "—",
        "—",
        "—",
      ]);
    });

    it("without model or pane, Agente shows only the agentKind and Pane «—»", async () => {
      const fake = new FakeApi();
      const task = fake.addTask(fake.addProject().id, {
        goal: "Sin modelo",
        state: "in_progress",
      });
      const run = fake.startRun(task.id, "implement");
      run.model = null;
      run.herdrPane = null;
      renderApp("/in-progress", fake);

      const cells = await rowOf("Sin modelo");
      expect(cells.slice(4)).toEqual(["0", "claude", "—"]);
    });

    it("a new Run arriving over the live stream replaces the row's values", async () => {
      class FakeEventSource {
        static instances: FakeEventSource[] = [];
        private readonly listeners = new Map<string, Set<(e: MessageEvent<string>) => void>>();
        readonly url: string;
        constructor(url: string) {
          this.url = url;
          FakeEventSource.instances.push(this);
        }
        addEventListener(type: string, fn: (e: MessageEvent<string>) => void) {
          if (!this.listeners.has(type)) this.listeners.set(type, new Set());
          this.listeners.get(type)?.add(fn);
        }
        removeEventListener(type: string, fn: (e: MessageEvent<string>) => void) {
          this.listeners.get(type)?.delete(fn);
        }
        close() {}
        emit(type: string, data: string) {
          for (const fn of this.listeners.get(type) ?? []) fn(new MessageEvent(type, { data }));
        }
      }
      vi.stubGlobal("EventSource", FakeEventSource);
      const fake = new FakeApi();
      const task = fake.addTask(fake.addProject().id, {
        goal: "En vivo",
        state: "in_progress",
        subState: "running",
      });
      const first = fake.startRun(task.id, "implement");
      first.herdrPane = "p-1";
      renderApp("/in-progress", fake);
      expect((await rowOf("En vivo")).slice(4)).toEqual(["0", "claude · opus", "p-1"]);

      fake.endRun(first.id, {});
      const next = fake.startRun(task.id, "implement");
      next.herdrPane = "p-9";
      next.iteration = 1;
      next.model = null;
      FakeEventSource.instances[0]?.emit("change", JSON.stringify({ taskIds: [task.id] }));

      await waitFor(async () =>
        expect((await rowOf("En vivo")).slice(4)).toEqual(["1", "claude", "p-9"]),
      );
    });

    it("a failed Runs query shows «error» and not «—», without affecting the other rows", async () => {
      const fake = new FakeApi();
      const project = fake.addProject();
      const broken = fake.addTask(project.id, { goal: "Rota", state: "in_progress" });
      const fine = fake.addTask(project.id, { goal: "Sana", state: "in_progress" });
      fake.startRun(broken.id, "implement");
      fake.startRun(fine.id, "implement").herdrPane = "p-ok";
      fake.runsFail.add(broken.id);
      renderApp("/in-progress", fake);

      expect((await rowOf("Rota")).slice(4)).toEqual(["error", "error", "error"]);
      expect((await rowOf("Sana")).slice(4)).toEqual(["0", "claude · opus", "p-ok"]);
    });

    it("the last Run's pane id of the task focuses its agent in herdr", async () => {
      const fake = new FakeApi();
      const task = fake.addTask(fake.addProject().id, { goal: "Con foco", state: "in_progress" });
      const older = fake.startRun(task.id, "implement");
      fake.endRun(older.id, {});
      const latest = fake.startRun(task.id, "verify");
      const { user } = renderApp("/in-progress", fake);

      await rowOf("Con foco");
      await user.click(
        await screen.findByRole("button", { name: `Enfocar pane ${latest.herdrPane} en herdr` }),
      );

      await waitFor(() => expect(fake.focused).toEqual([latest.herdrName]));
      expect(fake.requests.at(-1)).toMatchObject({
        method: "POST",
        path: `/api/runs/${latest.id}/focus`,
      });
      expect(
        screen.queryByRole("button", { name: `Enfocar pane ${older.herdrPane} en herdr` }),
      ).toBeNull();
    });

    it("while loading, with an error or without Runs the Pane cell is text, without a focus button", async () => {
      const fake = new FakeApi();
      const project = fake.addProject();
      fake.addTask(project.id, { goal: "Sin runs", state: "in_progress" });
      const broken = fake.addTask(project.id, { goal: "Rota", state: "in_progress" });
      fake.startRun(broken.id, "implement");
      fake.runsFail.add(broken.id);
      const noPane = fake.addTask(project.id, { goal: "Sin pane", state: "in_progress" });
      fake.startRun(noPane.id, "implement").herdrPane = null;
      renderApp("/in-progress", fake);

      expect((await rowOf("Sin runs")).at(-1)).toBe("—");
      expect((await rowOf("Rota")).at(-1)).toBe("error");
      expect((await rowOf("Sin pane")).at(-1)).toBe("—");
      expect(screen.queryByRole("button", { name: /Enfocar pane/ })).toBeNull();
    });

    it("while the Runs load the Pane cell says «…» as text, without a focus button", async () => {
      const fake = new FakeApi();
      const task = fake.addTask(fake.addProject().id, {
        goal: "Pendiente",
        state: "in_progress",
      });
      fake.startRun(task.id, "implement");
      let release = () => {};
      fake.runsGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      renderApp("/in-progress", fake);

      await screen.findByRole("link", { name: "Pendiente" });
      // The row is remounted when the columns load: it is read again until «…» appears.
      const read = () =>
        within(screen.getByRole("link", { name: "Pendiente" }).closest("tr") as HTMLElement)
          .getAllByRole("cell")
          .slice(0, -1)
          .map((c) => c.textContent);
      await waitFor(() => expect(read().slice(4)).toEqual(["…", "…", "…"]));
      const cells = read();
      expect(cells.slice(4)).toEqual(["…", "…", "…"]);
      expect(screen.queryByRole("button", { name: /Enfocar pane/ })).toBeNull();

      release();
      expect(await screen.findByRole("button", { name: /Enfocar pane/ })).toBeTruthy();
    });

    it("if a Runs refetch fails with previous cached data the Pane cell says «error», without a focus button", async () => {
      const fake = new FakeApi();
      const project = fake.addProject();
      const task = fake.addTask(project.id, { goal: "Se rompe", state: "in_progress" });
      const run = fake.startRun(task.id, "implement");
      const { queryClient } = renderApp("/in-progress", fake);

      expect(
        await screen.findByRole("button", { name: `Enfocar pane ${run.herdrPane} en herdr` }),
      ).toBeTruthy();

      fake.runsFail.add(task.id);
      await queryClient.invalidateQueries({ queryKey: queries.runs(task.id).queryKey });

      await waitFor(async () => expect((await rowOf("Se rompe")).at(-1)).toBe("error"));
      expect(screen.queryByRole("button", { name: /Enfocar pane/ })).toBeNull();
    });

    it("if the focus fails it shows the error next to that pane without touching the other rows", async () => {
      const fake = new FakeApi();
      const project = fake.addProject();
      const a = fake.addTask(project.id, { goal: "Falla", state: "in_progress" });
      const b = fake.addTask(project.id, { goal: "Intacta", state: "in_progress" });
      const runA = fake.startRun(a.id, "implement");
      const runB = fake.startRun(b.id, "implement");
      fake.focusError = { status: 502, error: "herdr_error", message: "herdr no responde" };
      const { user } = renderApp("/in-progress", fake);

      await rowOf("Falla");
      await user.click(
        await screen.findByRole("button", { name: `Enfocar pane ${runA.herdrPane} en herdr` }),
      );

      const row = (text: string) =>
        within(screen.getByRole("link", { name: text }).closest("tr") as HTMLElement);
      expect((await row("Falla").findByRole("alert")).textContent).toBe("herdr no responde");
      expect(row("Intacta").queryByRole("alert")).toBeNull();
      expect(row("Intacta").getByText(runB.herdrPane as string)).toBeTruthy();
    });

    it("when filtering by project each row keeps the values of its own task", async () => {
      const fake = new FakeApi();
      const one = fake.addProject({ name: "uno" });
      const two = fake.addProject({ name: "dos" });
      const a = fake.addTask(one.id, { goal: "De uno", state: "in_progress" });
      const b = fake.addTask(two.id, { goal: "De dos", state: "in_progress" });
      const runA = fake.startRun(a.id, "implement");
      runA.herdrPane = "p-a";
      runA.iteration = 3;
      const runB = fake.startRun(b.id, "implement");
      runB.herdrPane = "p-b";
      runB.model = "sonnet";
      const { user } = renderApp("/in-progress", fake);

      expect((await rowOf("De dos")).slice(4)).toEqual(["0", "claude · sonnet", "p-b"]);
      await user.selectOptions(screen.getByLabelText("Proyecto"), "uno");
      await waitFor(() => expect(screen.queryByText("De dos")).toBeNull());
      expect((await rowOf("De uno")).slice(4)).toEqual(["3", "claude · opus", "p-a"]);
    });
  });

  it("keeps the project when the user goes to another tab and comes back", async () => {
    const fake = new FakeApi();
    const one = fake.addProject({ name: "uno" });
    const two = fake.addProject({ name: "dos" });
    fake.addTask(one.id, { goal: "De uno", state: "in_progress", subState: "running" });
    fake.addTask(two.id, { goal: "De dos", state: "in_progress", subState: "queued" });
    const { user, router } = renderApp("/in-progress", fake);
    await screen.findByText("De dos");
    await user.selectOptions(screen.getByLabelText("Proyecto"), "uno");
    await waitFor(() => expect(screen.queryByText("De dos")).toBeNull());

    await router.navigate({ to: "/queue" });
    await screen.findByRole("heading", { name: "Cola global" });
    expect((screen.getByLabelText("Proyecto") as HTMLSelectElement).value).toBe("");
    await router.navigate({ to: "/in-progress" });

    await screen.findByText("De uno");
    expect((screen.getByLabelText("Proyecto") as HTMLSelectElement).value).toBe(one.id);
    expect(screen.queryByText("De dos")).toBeNull();
  });
});
