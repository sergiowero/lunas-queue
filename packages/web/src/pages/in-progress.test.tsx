import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FakeApi } from "../../test/fake-api.ts";
import { renderApp } from "../../test/render.tsx";
import { queries } from "../lib/queries.ts";

describe("pestaña En curso", () => {
  it("el enlace En curso de la navegación lleva a /in-progress y queda activo", async () => {
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

  it("lista las tareas In progress y las que tienen un agente corriendo, con proyecto, sub-estado y prioridad", async () => {
    const fake = new FakeApi();
    const one = fake.addProject({ name: "uno" });
    const two = fake.addProject({ name: "dos" });
    fake.addTask(one.id, { intent: "Borrador" });
    const verifying = fake.addTask(one.id, {
      intent: "Verificando",
      state: "verification",
      subState: "running",
    });
    fake.addTask(two.id, {
      intent: "Verificando en espera",
      state: "verification",
      subState: "waiting_human",
    });
    fake.addTask(two.id, { intent: "Terminada", state: "completed", subState: null });
    const running = fake.addTask(one.id, {
      intent: "Corriendo en uno",
      state: "in_progress",
      subState: "running",
      priority: 300,
    });
    const waiting = fake.addTask(two.id, {
      intent: "Esperando en dos",
      state: "in_progress",
      subState: "waiting_human",
      priority: 50,
    });
    renderApp("/in-progress", fake);

    const link = await screen.findByRole("link", { name: "Corriendo en uno" });
    expect(link.getAttribute("href")).toBe(`/tasks/${running.id}`);
    await waitFor(() => expect(screen.queryAllByText("…")).toHaveLength(0));
    const rows = screen.getAllByRole("row").slice(1);
    const cells = rows.map((r) =>
      within(r)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    );
    expect(cells).toContainEqual([
      `#${running.number}Corriendo en uno`,
      "uno",
      "corriendo",
      "300",
      "—",
      "—",
      "—",
    ]);
    expect(cells).toContainEqual([
      `#${waiting.number}Esperando en dos`,
      "dos",
      "esperando humano",
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

  describe("columnas Iteración, Agente y Pane", () => {
    const rowOf = async (text: string) => {
      await screen.findByRole("link", { name: text });
      // La fila se vuelve a montar al cambiar las columnas: se busca de nuevo en cada lectura.
      const read = () =>
        within(screen.getByRole("link", { name: text }).closest("tr") as HTMLElement)
          .getAllByRole("cell")
          .map((c) => c.textContent);
      await waitFor(() => expect(read()).not.toContain("…"));
      return read();
    };

    it("encabezados de la tabla: las existentes y las tres nuevas al final", async () => {
      const fake = new FakeApi();
      fake.addTask(fake.addProject().id, { intent: "Una", state: "in_progress" });
      renderApp("/in-progress", fake);

      await screen.findByRole("link", { name: "Una" });
      const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
      expect(headers).toEqual([
        "Tarea",
        "Proyecto",
        "Sub-estado",
        "Prioridad",
        "Iteración",
        "Agente",
        "Pane",
      ]);
    });

    it("muestra iteración, agente con modelo y pane del Run abierto", async () => {
      const fake = new FakeApi();
      const task = fake.addTask(fake.addProject({ name: "uno" }).id, {
        intent: "Con run",
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
        "corriendo",
        "10",
        "1",
        "claude · opus",
        "p-7",
      ]);
    });

    it("usa el Run más reciente cuando hay uno anterior terminado", async () => {
      const fake = new FakeApi();
      const task = fake.addTask(fake.addProject().id, {
        intent: "Dos runs",
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

    it("el Run más reciente se decide por startedAt, no por el orden de la respuesta", async () => {
      const fake = new FakeApi();
      const task = fake.addTask(fake.addProject().id, {
        intent: "Desordenados",
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

    it("sin Runs, las tres columnas muestran «—» y el resto de la fila se conserva", async () => {
      const fake = new FakeApi();
      const task = fake.addTask(fake.addProject({ name: "uno" }).id, {
        intent: "Sin runs",
        state: "in_progress",
        subState: "queued",
        priority: 5,
      });
      renderApp("/in-progress", fake);

      expect(await rowOf("Sin runs")).toEqual([
        `#${task.number}Sin runs`,
        "uno",
        "en cola",
        "5",
        "—",
        "—",
        "—",
      ]);
    });

    it("sin modelo ni pane, Agente muestra solo el agentKind y Pane «—»", async () => {
      const fake = new FakeApi();
      const task = fake.addTask(fake.addProject().id, {
        intent: "Sin modelo",
        state: "in_progress",
      });
      const run = fake.startRun(task.id, "implement");
      run.model = null;
      run.herdrPane = null;
      renderApp("/in-progress", fake);

      const cells = await rowOf("Sin modelo");
      expect(cells.slice(4)).toEqual(["0", "claude", "—"]);
    });

    it("un Run nuevo que llega por el stream en vivo reemplaza los valores de la fila", async () => {
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
        intent: "En vivo",
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

    it("una consulta de Runs fallida muestra «error» y no «—», sin afectar a las demás filas", async () => {
      const fake = new FakeApi();
      const project = fake.addProject();
      const broken = fake.addTask(project.id, { intent: "Rota", state: "in_progress" });
      const fine = fake.addTask(project.id, { intent: "Sana", state: "in_progress" });
      fake.startRun(broken.id, "implement");
      fake.startRun(fine.id, "implement").herdrPane = "p-ok";
      fake.runsFail.add(broken.id);
      renderApp("/in-progress", fake);

      expect((await rowOf("Rota")).slice(4)).toEqual(["error", "error", "error"]);
      expect((await rowOf("Sana")).slice(4)).toEqual(["0", "claude · opus", "p-ok"]);
    });

    it("el pane id del último Run de la tarea enfoca su agente en herdr", async () => {
      const fake = new FakeApi();
      const task = fake.addTask(fake.addProject().id, { intent: "Con foco", state: "in_progress" });
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

    it("cargando, con error o sin Runs la celda Pane es texto, sin botón de foco", async () => {
      const fake = new FakeApi();
      const project = fake.addProject();
      fake.addTask(project.id, { intent: "Sin runs", state: "in_progress" });
      const broken = fake.addTask(project.id, { intent: "Rota", state: "in_progress" });
      fake.startRun(broken.id, "implement");
      fake.runsFail.add(broken.id);
      const noPane = fake.addTask(project.id, { intent: "Sin pane", state: "in_progress" });
      fake.startRun(noPane.id, "implement").herdrPane = null;
      renderApp("/in-progress", fake);

      expect((await rowOf("Sin runs")).at(-1)).toBe("—");
      expect((await rowOf("Rota")).at(-1)).toBe("error");
      expect((await rowOf("Sin pane")).at(-1)).toBe("—");
      expect(screen.queryByRole("button", { name: /Enfocar pane/ })).toBeNull();
    });

    it("mientras carga los Runs la celda Pane dice «…» como texto, sin botón de foco", async () => {
      const fake = new FakeApi();
      const task = fake.addTask(fake.addProject().id, {
        intent: "Pendiente",
        state: "in_progress",
      });
      fake.startRun(task.id, "implement");
      let release = () => {};
      fake.runsGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      renderApp("/in-progress", fake);

      await screen.findByRole("link", { name: "Pendiente" });
      // La fila se vuelve a montar al cargar las columnas: se lee de nuevo hasta que aparezca «…».
      const read = () =>
        within(screen.getByRole("link", { name: "Pendiente" }).closest("tr") as HTMLElement)
          .getAllByRole("cell")
          .map((c) => c.textContent);
      await waitFor(() => expect(read().slice(4)).toEqual(["…", "…", "…"]));
      const cells = read();
      expect(cells.slice(4)).toEqual(["…", "…", "…"]);
      expect(screen.queryByRole("button", { name: /Enfocar pane/ })).toBeNull();

      release();
      expect(await screen.findByRole("button", { name: /Enfocar pane/ })).toBeTruthy();
    });

    it("si un refetch de los Runs falla con datos previos en caché la celda Pane dice «error», sin botón de foco", async () => {
      const fake = new FakeApi();
      const project = fake.addProject();
      const task = fake.addTask(project.id, { intent: "Se rompe", state: "in_progress" });
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

    it("si el foco falla muestra el error junto a ese pane sin tocar las demás filas", async () => {
      const fake = new FakeApi();
      const project = fake.addProject();
      const a = fake.addTask(project.id, { intent: "Falla", state: "in_progress" });
      const b = fake.addTask(project.id, { intent: "Intacta", state: "in_progress" });
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

    it("al filtrar por proyecto cada fila conserva los valores de su propia tarea", async () => {
      const fake = new FakeApi();
      const one = fake.addProject({ name: "uno" });
      const two = fake.addProject({ name: "dos" });
      const a = fake.addTask(one.id, { intent: "De uno", state: "in_progress" });
      const b = fake.addTask(two.id, { intent: "De dos", state: "in_progress" });
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
});
