import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FakeApi, SPEC_CONTENT } from "../../test/fake-api.ts";
import { renderApp } from "../../test/render.tsx";
import * as format from "../lib/format.ts";

vi.mock("../lib/format.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/format.ts")>();
  return { ...actual, formatAgent: vi.fn(actual.formatAgent) };
});

function seeded() {
  const fake = new FakeApi();
  const project = fake.addProject({ name: "lunas-queue" });
  const dep = fake.addTask(project.id, { goal: "Esquema de usuarios" });
  const task = fake.addTask(project.id, {
    goal: "Login con email",
    tags: ["auth"],
    priority: 200,
    worktreePath: "/w/login",
    branch: "lunasq/login",
  });
  fake.edges.push({ taskId: task.id, dependsOnId: dep.id });
  return { fake, project, dep, task };
}

const section = async (name: string) => within(await screen.findByRole("region", { name }));

describe("task detail", () => {
  it("shows header, dependencies and state", async () => {
    const { fake, task, dep } = seeded();
    fake.transition(task.id, "refined", null);
    renderApp(`/tasks/${task.id}`, fake);

    expect(await screen.findByRole("heading", { name: "Login con email" })).toBeTruthy();
    expect(screen.getByText("Refined")).toBeTruthy();
    expect(screen.getByText("lunasq/login")).toBeTruthy();
    expect(await screen.findByRole("link", { name: "lunas-queue" })).toBeTruthy();
    expect(
      await (await section("Dependencias")).findByRole("link", { name: dep.goal }),
    ).toBeTruthy();
  });

  it("with a title it shows it as the heading and leaves the goal below", async () => {
    const { fake, task } = seeded();
    task.title = "Login por correo";
    renderApp(`/tasks/${task.id}`, fake);

    expect(await screen.findByRole("heading", { name: "Login por correo" })).toBeTruthy();
    expect(screen.getByText("Login con email")).toBeTruthy();
  });

  it("an In progress task shows its state label in blue", async () => {
    const { fake, task } = seeded();
    fake.transition(task.id, "in_progress", "running");
    renderApp(`/tasks/${task.id}`, fake);

    await screen.findByRole("heading", { name: "Login con email" });
    expect(screen.getByText("In progress").dataset.variant).toBe("info");
    expect(screen.getByText("corriendo")).toBeTruthy();
  });

  it("adds and removes dependencies while the task is in draft", async () => {
    const { fake, project, task, dep } = seeded();
    const other = fake.addProject({ name: "api" });
    const extra = fake.addTask(other.id, { goal: "Endpoint de login" });
    fake.addTask(project.id, { goal: "Ya cancelada", state: "cancelled", subState: null });
    const { user } = renderApp(`/tasks/${task.id}`, fake);

    const deps = await section("Dependencias");
    const select = await deps.findByLabelText("Agregar dependencia");
    // The options carry the #N in front («#N · goal»): it is looked up by the end of the name.
    expect(select.querySelectorAll("option")).toHaveLength(2);
    expect(deps.queryByRole("option", { name: new RegExp(`· ${dep.goal}$`) })).toBeNull();
    expect(deps.queryByRole("option", { name: /· Ya cancelada$/ })).toBeNull();
    expect(deps.queryByRole("option", { name: new RegExp(`· ${task.goal}$`) })).toBeNull();
    expect(deps.getByRole("option", { name: new RegExp(`· ${extra.goal}$`) })).toBeTruthy();
    await user.selectOptions(select, extra.id);
    await user.click(deps.getByRole("button", { name: "Agregar" }));

    expect(await deps.findByRole("link", { name: extra.goal })).toBeTruthy();
    expect(deps.getByText("otro proyecto")).toBeTruthy();
    expect(fake.edges).toContainEqual({ taskId: task.id, dependsOnId: extra.id });

    await user.click(deps.getByRole("button", { name: `Quitar dependencia ${dep.goal}` }));
    await waitFor(() => expect(deps.queryByRole("link", { name: dep.goal })).toBeNull());
    expect(fake.edges).toEqual([{ taskId: task.id, dependsOnId: extra.id }]);
  });

  it("shows the server's error if the dependency closes a cycle", async () => {
    const { fake, task, dep } = seeded();
    const { user } = renderApp(`/tasks/${dep.id}`, fake);

    const deps = await section("Dependencias");
    await user.selectOptions(await deps.findByLabelText("Agregar dependencia"), task.id);
    await user.click(deps.getByRole("button", { name: "Agregar" }));
    expect((await deps.findByRole("alert")).textContent).toContain("ciclo");
    expect(fake.edges).toHaveLength(1);
  });

  it("does not offer editing dependencies outside draft", async () => {
    const { fake, task } = seeded();
    fake.transition(task.id, "refined", null);
    renderApp(`/tasks/${task.id}`, fake);

    const deps = await section("Dependencias");
    await deps.findByText("Depende de");
    expect(deps.queryByLabelText("Agregar dependencia")).toBeNull();
    expect(deps.queryByRole("button", { name: /Quitar dependencia/ })).toBeNull();
  });

  it("lists the Runs with result, failure_reason, pane and handoff", async () => {
    const { fake, task } = seeded();
    const failed = fake.startRun(task.id, "refine");
    fake.endRun(failed.id, { result: "failure", failureReason: "timeout de fase (60 min)" });
    const ok = fake.startRun(task.id, "refine");
    fake.endRun(ok.id, {
      handoff: {
        phase: "refinement",
        summary: "Spec lista para implementar",
        body: {
          requirements: ["Validar los datos", "Mostrar errores claros"],
          criteria: [
            {
              id: "AC-1",
              given: "datos válidos",
              when: "se envía el formulario",
              outcome: "se guarda",
            },
          ],
        },
      },
    });
    const { user } = renderApp(`/tasks/${task.id}`, fake);

    const runs = await section("Runs");
    const rows = await runs.findAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(within(rows[1] as HTMLElement).getByText("claude · opus")).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText("fallo")).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText("timeout de fase (60 min)")).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText("éxito")).toBeTruthy();
    const openHandoff = within(rows[2] as HTMLElement).getByRole("button", {
      name: "Abrir handoff",
    });
    await user.click(openHandoff);
    const dialog = await screen.findByRole("dialog", { name: "Handoff · Refinamiento" });
    expect(within(dialog).getByText("Spec lista para implementar")).toBeTruthy();
    const requirements = within(dialog).getByText("Requisitos (2)");
    expect(requirements).toBeTruthy();
    await user.click(requirements);
    expect(within(dialog).getByText("Validar los datos")).toBeTruthy();
    expect(within(dialog).getByText("AC-1")).toBeTruthy();
    expect(within(dialog).queryByText(/"summary":/)).toBeNull();
    expect(within(dialog).queryByRole("textbox")).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Cerrar" }));
    expect(within(rows[1] as HTMLElement).getByText(failed.herdrPane as string)).toBeTruthy();
  });

  it("the pane id of a Run in the Runs panel focuses its agent in herdr", async () => {
    const { fake, task } = seeded();
    const first = fake.startRun(task.id, "refine");
    fake.endRun(first.id, {});
    const second = fake.startRun(task.id, "implement");
    const { user } = renderApp(`/tasks/${task.id}`, fake);

    const runs = await section("Runs");
    const button = await runs.findByRole("button", {
      name: `Enfocar pane ${first.herdrPane} en herdr`,
    });
    await user.click(button);

    await waitFor(() => expect(fake.focused).toEqual([first.herdrName]));
    expect(fake.requests.at(-1)).toMatchObject({
      method: "POST",
      path: `/api/runs/${first.id}/focus`,
    });
    expect(
      runs.getByRole("button", { name: `Enfocar pane ${second.herdrPane} en herdr` }),
    ).toBeTruthy();
  });

  it("a Run without a pane shows «—» as text, without a focus button", async () => {
    const { fake, task } = seeded();
    const run = fake.startRun(task.id, "refine");
    run.herdrPane = null;
    renderApp(`/tasks/${task.id}`, fake);

    const runs = await section("Runs");
    const row = within((await runs.findAllByRole("row"))[1] as HTMLElement);
    expect(row.getAllByRole("cell")[3]?.textContent).toBe("—");
    expect(row.queryByRole("button", { name: /Enfocar pane/ })).toBeNull();
  });

  it("if the focus fails it shows the error next to that pane and leaves the table and the other rows", async () => {
    const { fake, task } = seeded();
    const first = fake.startRun(task.id, "refine");
    fake.endRun(first.id, {});
    const second = fake.startRun(task.id, "implement");
    fake.focusError = {
      status: 409,
      error: "agent_gone",
      message: "lunasq-refine ya no está en herdr",
    };
    const { user } = renderApp(`/tasks/${task.id}`, fake);

    const runs = await section("Runs");
    await user.click(
      await runs.findByRole("button", { name: `Enfocar pane ${first.herdrPane} en herdr` }),
    );

    const rows = runs.getAllByRole("row");
    expect((await within(rows[1] as HTMLElement).findByRole("alert")).textContent).toBe(
      "El agente ya no está en herdr.",
    );
    expect(within(rows[2] as HTMLElement).queryByRole("alert")).toBeNull();
    expect(within(rows[2] as HTMLElement).getByText(second.herdrPane as string)).toBeTruthy();
    expect(fake.focused).toEqual([]);
  });

  it("the Runs panel gets the Agent from the shared formatAgent helper", async () => {
    const { fake, task } = seeded();
    fake.startRun(task.id, "refine");
    const original = vi.mocked(format.formatAgent).getMockImplementation();
    vi.mocked(format.formatAgent).mockImplementation(() => "agente-del-helper");
    try {
      renderApp(`/tasks/${task.id}`, fake);
      const runs = await section("Runs");
      expect(await runs.findByText("agente-del-helper")).toBeTruthy();
    } finally {
      if (original) vi.mocked(format.formatAgent).mockImplementation(original);
    }
  });

  it("shows the last page of Runs by default and allows navigating", async () => {
    const { fake, task } = seeded();
    const runs = Array.from({ length: 11 }, () => fake.startRun(task.id, "implement"));
    const { user } = renderApp(`/tasks/${task.id}`, fake);

    const panel = await section("Runs");
    expect(await panel.findByText(runs[10]?.herdrPane as string)).toBeTruthy();
    expect(panel.queryByText(runs[0]?.herdrPane as string)).toBeNull();
    expect(within(await panel.findByRole("table")).getAllByRole("row")).toHaveLength(2);
    expect(panel.getByText("Página 2 de 2")).toBeTruthy();

    await user.click(await panel.findByRole("button", { name: "Anterior" }));
    expect(await panel.findByText(runs[0]?.herdrPane as string)).toBeTruthy();
    expect(within(panel.getByRole("table")).getAllByRole("row")).toHaveLength(11);
  });

  it("shows the Event log with actor and transition", async () => {
    const { fake, task } = seeded();
    fake.transition(task.id, "refined", null);
    renderApp(`/tasks/${task.id}`, fake);
    const log = await section("Event log");
    expect(await log.findByText("task.created")).toBeTruthy();
    expect(log.getByText("Draft · en cola → Refined")).toBeTruthy();
    expect(log.getAllByText("system")).toHaveLength(1);
  });

  it("the Event log is collapsed by default", async () => {
    const { fake, task } = seeded();
    renderApp(`/tasks/${task.id}`, fake);
    const log = await section("Event log");
    const details = (await log.findByText(/Mostrar \d+ eventos?/)).closest("details");
    expect(details?.open).toBe(false);
  });

  it("shows recorded consumption and explains that Copilot and Codex usage is not available", async () => {
    const { fake, task } = seeded();
    const run = fake.startRun(task.id, "implement");
    const copilotRun = fake.startRun(task.id, "verify");
    copilotRun.agentKind = "copilot";
    const usage = {
      inputTokens: 300,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheWriteTokens: 0,
      costUsd: 0.25,
    };
    fake.usage.set(task.id, {
      total: usage,
      byRun: [{ runId: run.id, phase: "implement", usage }],
      byPhase: [{ phase: "implement", usage }],
      byAgent: [{ agentKind: "claude", usage }],
      byModel: [{ model: "opus", usage }],
      byReviewer: [],
    });
    renderApp(`/tasks/${task.id}`, fake);
    const block = await section("Usage");
    expect(
      await block.findByText(
        /Consumo registrado \(parcial: Copilot y Codex CLI no informan usage\)/,
      ),
    ).toBeTruthy();
    expect(block.getByText(/360 tokens · \$0,25/)).toBeTruthy();
    expect(block.getByText("Implementación")).toBeTruthy();
    expect(block.getAllByText("No disponible")).toHaveLength(4);
  });

  it("shows the last page of Usage by default and allows navigating", async () => {
    const { fake, task } = seeded();
    const runs = Array.from({ length: 11 }, () => fake.startRun(task.id, "implement"));
    fake.usage.set(task.id, {
      total: {
        inputTokens: 66,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
      },
      byRun: runs.map((run, index) => ({
        runId: run.id,
        phase: run.phase,
        usage: {
          inputTokens: index + 1,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0,
        },
      })),
      byPhase: [],
      byAgent: [],
      byModel: [],
      byReviewer: [],
    });
    const { user } = renderApp(`/tasks/${task.id}`, fake);

    const panel = await section("Usage");
    expect(await panel.findByText("11")).toBeTruthy();
    expect(panel.queryByText("1", { selector: "td" })).toBeNull();
    expect(panel.getByText("Página 2 de 2")).toBeTruthy();

    await user.click(panel.getByRole("button", { name: "Anterior" }));
    expect(await panel.findByText("1", { selector: "td" })).toBeTruthy();
    expect(panel.queryByText("11", { selector: "td" })).toBeNull();
    expect(within(panel.getByRole("table")).getAllByRole("row")).toHaveLength(11);
  });

  describe("Result of a task without code", () => {
    const withResult = () => {
      const { fake, task } = seeded();
      Object.assign(task, {
        state: "completed",
        subState: null,
        resultKind: "research",
        result: "# Hallazgos\n\nSQLite basta para **un** proceso.",
      });
      return { fake, task };
    };

    it("AC-9: shows the Resultado section with the type and the text rendered as Markdown", async () => {
      const { fake, task } = withResult();
      renderApp(`/tasks/${task.id}`, fake);

      const block = await section("Resultado");
      expect(block.getByText("Investigación")).toBeTruthy();
      expect(block.getByRole("heading", { name: "Hallazgos" })).toBeTruthy();
      expect(block.getByText("un").tagName).toBe("STRONG");
    });

    it("AC-9: the PR field says it has no PR", async () => {
      const { fake, task } = withResult();
      renderApp(`/tasks/${task.id}`, fake);

      await screen.findByRole("region", { name: "Resultado" });
      const field = screen.getByText("PR", { selector: "dt" }).parentElement;
      expect(field?.textContent).toContain("Sin PR");
    });

    it.each([
      ["already_implemented", "Ya implementada"],
      ["not_resolvable", "Sin resolución"],
    ] as const)("el tipo %s se muestra como «%s»", async (kind, label) => {
      const { fake, task } = withResult();
      task.resultKind = kind;
      renderApp(`/tasks/${task.id}`, fake);

      expect(await (await section("Resultado")).findByText(label)).toBeTruthy();
    });

    it("AC-11: a task without a Result does not show the Resultado section", async () => {
      const { fake, task } = seeded();
      Object.assign(task, { state: "completed", subState: null, prState: "merged" });
      renderApp(`/tasks/${task.id}`, fake);

      await screen.findByRole("heading", { name: "Login con email" });
      expect(screen.queryByRole("region", { name: "Resultado" })).toBeNull();
      expect(screen.getByText("PR", { selector: "dt" }).parentElement?.textContent).not.toContain(
        "Sin PR",
      );
    });
  });

  describe("Markdown in the Result", () => {
    const TABLE = "| Opción | Coste |\n| --- | --- |\n| SQLite | bajo |\n| Postgres | alto |";
    const render = (result: string) => {
      const { fake, task } = seeded();
      Object.assign(task, { state: "completed", subState: null, resultKind: "research", result });
      renderApp(`/tasks/${task.id}`, fake);
      return section("Resultado");
    };

    it("AC-1: a GFM table is rendered with column headers and data cells", async () => {
      const block = await render(`# Comparativa\n\n${TABLE}`);

      const table = await block.findByRole("table");
      expect(
        within(table)
          .getAllByRole("columnheader")
          .map((c) => c.textContent),
      ).toEqual(["Opción", "Coste"]);
      const rows = within(table).getAllByRole("row");
      expect(rows).toHaveLength(3);
      expect(
        within(rows[1] as HTMLElement)
          .getAllByRole("cell")
          .map((c) => c.textContent),
      ).toEqual(["SQLite", "bajo"]);
      expect(
        within(rows[2] as HTMLElement)
          .getAllByRole("cell")
          .map((c) => c.textContent),
      ).toEqual(["Postgres", "alto"]);
    });

    it("AC-2: an image is rendered with its alt text and src", async () => {
      const block = await render("![Diagrama](https://example.com/d.png)");

      const img = await block.findByRole("img", { name: "Diagrama" });
      expect(img.getAttribute("src")).toBe("https://example.com/d.png");
    });

    it("AC-3: the table scrolls horizontally with bordered, padded cells and the image fits the section", async () => {
      const block = await render(`${TABLE}\n\n![Diagrama](https://example.com/d.png)`);

      const table = await block.findByRole("table");
      expect(table.parentElement?.className).toContain("overflow-x-auto");
      expect(table.className).toContain("border-collapse");
      const cell = block.getByRole("columnheader", { name: "Opción" });
      expect(cell.className).toMatch(/\bborder\b/);
      expect(cell.className).toMatch(/\bpx-\d/);
      expect(cell.className).toMatch(/\bpy-\d/);
      expect(block.getByRole("cell", { name: "SQLite" }).className).toMatch(/\bborder\b/);
      const img = block.getByRole("img", { name: "Diagrama" });
      expect(img.className).toContain("max-w-full");
      expect(img.className).toContain("h-auto");
    });

    it("AC-4: raw HTML is not interpreted", async () => {
      const block = await render(
        "Antes\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n<b>negrita</b>",
      );

      await block.findByText(/Antes/);
      const region = screen.getByRole("region", { name: "Resultado" });
      expect(region.querySelector("script")).toBeNull();
      expect(region.querySelector("img")).toBeNull();
      expect(region.querySelector("b")).toBeNull();
    });

    it("AC-5: an image with a javascript: URL does not keep it as src", async () => {
      const block = await render(
        "![malo](javascript:alert(1)) y ![bueno](https://example.com/b.png)",
      );

      await block.findByRole("img", { name: "bueno" });
      const region = screen.getByRole("region", { name: "Resultado" });
      for (const img of Array.from(region.querySelectorAll("img"))) {
        expect(img.getAttribute("src") ?? "").not.toMatch(/javascript:/i);
      }
    });

    it("AC-6: headings and bold text keep rendering next to a table", async () => {
      const block = await render(`# Hallazgos\n\nSQLite basta para **un** proceso.\n\n${TABLE}`);

      expect(await block.findByRole("heading", { name: "Hallazgos" })).toBeTruthy();
      expect(block.getByText("un").tagName).toBe("STRONG");
    });
  });

  it("AC-7: a GFM table in the evidence is rendered as an HTML table", async () => {
    const { fake, task } = seeded();
    fake.evidence.set(
      task.id,
      "# Evidencia\n\n| Check | Estado |\n| --- | --- |\n| tests | verde |",
    );
    const { user } = renderApp(`/tasks/${task.id}`, fake);
    const block = await section("Evidencia");
    await user.click(await block.findByRole("button", { name: "Mostrar evidencia" }));

    const table = await block.findByRole("table");
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((c) => c.textContent),
    ).toEqual(["Check", "Estado"]);
    expect(within(table).getByRole("cell", { name: "verde" })).toBeTruthy();
  });

  it("the Evidencia panel starts collapsed and does not show the evidence", async () => {
    const { fake, task } = seeded();
    fake.evidence.set(task.id, "# Evidencia\n\n## Run 1\n\nTodo **verde**.");
    renderApp(`/tasks/${task.id}`, fake);
    const block = await section("Evidencia");
    const toggle = await block.findByRole("button", { name: "Mostrar evidencia" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(block.queryByRole("heading", { name: "Run 1" })).toBeNull();
    expect(block.queryByText(`/w/login/lunasq/tasks/${task.id}.md`)).toBeNull();
  });

  it("expanding the Evidencia panel shows origin, path and markdown", async () => {
    const { fake, task } = seeded();
    fake.evidence.set(task.id, "# Evidencia\n\n## Run 1\n\nTodo **verde**.");
    const { user } = renderApp(`/tasks/${task.id}`, fake);
    const block = await section("Evidencia");
    await user.click(await block.findByRole("button", { name: "Mostrar evidencia" }));
    expect(await block.findByRole("heading", { name: "Run 1" })).toBeTruthy();
    expect(block.getByText("verde").tagName).toBe("STRONG");
    expect(block.getByText(/Desde worktree/)).toBeTruthy();
    expect(block.getByText(`/w/login/lunasq/tasks/${task.id}.md`)).toBeTruthy();
  });

  it("collapsing the Evidencia panel again hides the evidence", async () => {
    const { fake, task } = seeded();
    fake.evidence.set(task.id, "# Evidencia\n\n## Run 1\n\nTodo **verde**.");
    const { user } = renderApp(`/tasks/${task.id}`, fake);
    const block = await section("Evidencia");
    const toggle = await block.findByRole("button", { name: "Mostrar evidencia" });
    await user.click(toggle);
    expect(await block.findByRole("heading", { name: "Run 1" })).toBeTruthy();
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(block.queryByRole("heading", { name: "Run 1" })).toBeNull();
    expect(screen.getByRole("region", { name: "Evidencia" })).toBeTruthy();
  });

  it("the Evidencia panel expands with the keyboard", async () => {
    const { fake, task } = seeded();
    fake.evidence.set(task.id, "# Evidencia\n\n## Run 1");
    const { user } = renderApp(`/tasks/${task.id}`, fake);
    const block = await section("Evidencia");
    const toggle = await block.findByRole("button", { name: "Mostrar evidencia" });
    toggle.focus();
    await user.keyboard("{Enter}");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(await block.findByRole("heading", { name: "Run 1" })).toBeTruthy();
  });

  it("the Evidencia panel starts collapsed when returning to an already visited task", async () => {
    const { fake, task, dep } = seeded();
    fake.evidence.set(task.id, "# Evidencia\n\n## Run 1");
    fake.evidence.set(dep.id, "# Evidencia\n\n## Run 2");
    const { user, router } = renderApp(`/tasks/${task.id}`, fake);
    const toggleOf = async () =>
      (await section("Evidencia")).findByRole("button", { name: "Mostrar evidencia" });

    await toggleOf();
    await router.navigate({ to: "/tasks/$taskId", params: { taskId: dep.id } });
    const depToggle = await toggleOf();
    await user.click(depToggle);
    expect(depToggle.getAttribute("aria-expanded")).toBe("true");

    await router.navigate({ to: "/tasks/$taskId", params: { taskId: task.id } });
    await waitFor(async () =>
      expect(screen.getByRole("heading", { name: "Login con email" })).toBeTruthy(),
    );
    expect((await toggleOf()).getAttribute("aria-expanded")).toBe("false");

    await router.navigate({ to: "/tasks/$taskId", params: { taskId: dep.id } });
    await waitFor(async () =>
      expect(screen.getByRole("heading", { name: "Esquema de usuarios" })).toBeTruthy(),
    );
    expect((await toggleOf()).getAttribute("aria-expanded")).toBe("false");
  });

  it("warns when there is no evidence file yet on expanding the panel", async () => {
    const { fake, task } = seeded();
    const { user } = renderApp(`/tasks/${task.id}`, fake);
    const block = await section("Evidencia");
    const toggle = await block.findByRole("button", { name: "Mostrar evidencia" });
    expect(block.queryByText("Todavía no hay archivo de evidencia.")).toBeNull();
    await user.click(toggle);
    expect(await block.findByText("Todavía no hay archivo de evidencia.")).toBeTruthy();
    await user.click(toggle);
    expect(block.queryByText("Todavía no hay archivo de evidencia.")).toBeNull();
  });

  it("says where the evidence came from when there is no worktree anymore", async () => {
    const { fake, task } = seeded();
    fake.evidence.set(task.id, "# Evidencia");
    fake.evidenceSource.set(task.id, "branch");
    const { user } = renderApp(`/tasks/${task.id}`, fake);
    const block = await section("Evidencia");
    await user.click(await block.findByRole("button", { name: "Mostrar evidencia" }));
    expect(await block.findByText(`origin/lunasq/login:lunasq/tasks/${task.id}.md`)).toBeTruthy();
    expect(block.getByText(/Desde branch de la tarea/)).toBeTruthy();
  });

  it("shows the spec versions, their content and the diff against the previous one", async () => {
    const { fake, task } = seeded();
    fake.addSpec(task.id);
    fake.addSpec(task.id, {
      ...SPEC_CONTENT,
      criteria: [
        ...SPEC_CONTENT.criteria,
        { id: "AC-2", given: "contraseña errónea", when: "inicia sesión", outcome: "ve un error" },
      ],
    });
    const { user } = renderApp(`/tasks/${task.id}`, fake);

    const spec = await section("Spec");
    expect(await spec.findByRole("button", { name: "v2" })).toHaveProperty("ariaPressed", "true");
    expect(spec.getByText(/AC-2/)).toBeTruthy();
    expect(spec.getByText("El usuario inicia sesión con email")).toBeTruthy();
    expect(await spec.findByText("Cambios contra v1")).toBeTruthy();

    await user.click(spec.getByRole("button", { name: "v1" }));
    await waitFor(() => expect(spec.queryByText(/AC-2/)).toBeNull());
    expect(await spec.findByText("Primera versión")).toBeTruthy();
  });

  it("approves the pending version of a refined task", async () => {
    const { fake, task } = seeded();
    fake.transition(task.id, "refined", null);
    fake.addSpec(task.id);
    const { user } = renderApp(`/tasks/${task.id}`, fake);

    await user.click(await (await section("Spec")).findByRole("button", { name: "Aprobar v1" }));
    expect(await screen.findByText("In progress")).toBeTruthy();
    expect(fake.requests.some((r) => r.path === `/api/tasks/${task.id}/specs/1/approve`)).toBe(
      true,
    );
    expect((await section("Spec")).queryByRole("button", { name: "Aprobar v1" })).toBeNull();
  });

  it("shows the server's 409 if the spec is no longer pending", async () => {
    const { fake, task } = seeded();
    fake.transition(task.id, "refined", null);
    const spec = fake.addSpec(task.id);
    const { user } = renderApp(`/tasks/${task.id}`, fake);
    const approve = await (await section("Spec")).findByRole("button", { name: "Aprobar v1" });
    spec.approval = "approved";
    await user.click(approve);
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "version 1 is already approved",
    );
  });

  it("shows the new version when it arrives while reviewing an earlier one", async () => {
    const { fake, task } = seeded();
    fake.transition(task.id, "refined", null);
    fake.addSpec(task.id);
    fake.addSpec(task.id);
    const { user, refresh } = renderApp(`/tasks/${task.id}`, fake);
    const spec = await section("Spec");
    await user.click(await spec.findByRole("button", { name: "v1" }));
    fake.addSpec(task.id);
    await refresh();
    expect(await spec.findByRole("button", { name: "Aprobar v3" })).toBeTruthy();
  });

  it("requests changes with comments", async () => {
    const { fake, task } = seeded();
    fake.transition(task.id, "refined", null);
    fake.addSpec(task.id);
    const { user } = renderApp(`/tasks/${task.id}`, fake);

    const spec = await section("Spec");
    await user.type(await spec.findByLabelText("Comentarios"), "Falta el caso de bloqueo");
    await user.click(spec.getByRole("button", { name: "Pedir cambios" }));
    expect(await spec.findByText("Comentarios de revisión: Falta el caso de bloqueo")).toBeTruthy();
    expect(fake.requests.find((r) => r.path.endsWith("/request-changes"))?.body).toEqual({
      comments: "Falta el caso de bloqueo",
    });
  });

  it("edits the spec and approves it as a new human version", async () => {
    const { fake, task } = seeded();
    fake.transition(task.id, "refined", null);
    fake.addSpec(task.id);
    const { user } = renderApp(`/tasks/${task.id}`, fake);

    const spec = await section("Spec");
    await user.click(await spec.findByRole("button", { name: "Editar y aprobar" }));
    const editor = spec.getByLabelText("Contenido de la spec (JSON)") as HTMLTextAreaElement;
    expect(JSON.parse(editor.value)).toEqual(SPEC_CONTENT);
    const edited = { ...SPEC_CONTENT, requirements: ["El usuario inicia sesión con SSO"] };
    await user.clear(editor);
    // user.type interprets { and [ as special keys; the JSON is pasted as is.
    await user.click(editor);
    await user.paste(JSON.stringify(edited));
    await user.click(spec.getByRole("button", { name: "Guardar y aprobar" }));

    expect(await screen.findByText("In progress")).toBeTruthy();
    const latest = fake.specs.at(-1);
    expect(latest).toMatchObject({ version: 2, createdBy: "human", approval: "approved" });
    expect(latest?.content.requirements).toEqual(["El usuario inicia sesión con SSO"]);
    expect(fake.task(task.id).state).toBe("in_progress");
  });

  it("does not send an edit that is not valid JSON", async () => {
    const { fake, task } = seeded();
    fake.transition(task.id, "refined", null);
    fake.addSpec(task.id);
    const { user } = renderApp(`/tasks/${task.id}`, fake);

    const spec = await section("Spec");
    await user.click(await spec.findByRole("button", { name: "Editar y aprobar" }));
    const editor = spec.getByLabelText("Contenido de la spec (JSON)");
    await user.clear(editor);
    await user.type(editor, "no es json");
    await user.click(spec.getByRole("button", { name: "Guardar y aprobar" }));

    expect((await spec.findByRole("alert")).textContent).toMatch(/JSON inválido/);
    expect(fake.requests.some((r) => r.path.endsWith("/edit-and-approve"))).toBe(false);
  });

  it("shows the server's validation errors when editing", async () => {
    const { fake, task } = seeded();
    fake.transition(task.id, "refined", null);
    fake.addSpec(task.id);
    const { user } = renderApp(`/tasks/${task.id}`, fake);

    const spec = await section("Spec");
    await user.click(await spec.findByRole("button", { name: "Editar y aprobar" }));
    const editor = spec.getByLabelText("Contenido de la spec (JSON)");
    await user.clear(editor);
    await user.click(editor);
    await user.paste("{}");
    await user.click(spec.getByRole("button", { name: "Guardar y aprobar" }));

    expect((await spec.findByRole("alert")).textContent).toMatch(/content\.domainModel: /);
    expect(fake.task(task.id).state).toBe("refined");
  });

  it("shows only the error of the last action on the spec", async () => {
    const { fake, task } = seeded();
    fake.transition(task.id, "refined", null);
    fake.addSpec(task.id);
    const { user } = renderApp(`/tasks/${task.id}`, fake);

    const spec = await section("Spec");
    // Another actor takes the task out of refined: approving answers 409.
    fake.task(task.id).state = "in_progress";
    await user.click(await spec.findByRole("button", { name: "Aprobar v1" }));
    expect((await spec.findByRole("alert")).textContent).toMatch(/not refined/);
    fake.task(task.id).state = "refined";
    await user.click(await spec.findByRole("button", { name: "Editar y aprobar" }));
    const editor = spec.getByLabelText("Contenido de la spec (JSON)");
    await user.clear(editor);
    await user.click(editor);
    await user.paste("{}");
    await user.click(spec.getByRole("button", { name: "Guardar y aprobar" }));

    const alert = await spec.findByRole("alert");
    await waitFor(() => expect(alert.textContent).toMatch(/content\.domainModel/));
    expect(alert.textContent).not.toMatch(/not refined/);
  });

  it("cancels the task after confirming", async () => {
    const { fake, task } = seeded();
    const { user } = renderApp(`/tasks/${task.id}`, fake);
    await user.click(await screen.findByRole("button", { name: "Cancelar tarea" }));
    await user.click(screen.getByRole("button", { name: "Sí, cancelar" }));
    expect(await screen.findByText("Cancelled")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancelar tarea" })).toBeNull();
  });

  it("resumes a task in needs_human to the state it was escalated from", async () => {
    const { fake, task } = seeded();
    fake.transition(task.id, "needs_human", null);
    const { user } = renderApp(`/tasks/${task.id}`, fake);
    await user.click(await screen.findByRole("button", { name: "Reanudar tarea" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Reanudar tarea" })).toBeNull(),
    );
    expect(fake.task(task.id).state).toBe("draft");
    expect(screen.getByRole("button", { name: "Cancelar tarea" })).toBeTruthy();
  });

  it("does not offer resuming outside needs_human and paused", async () => {
    const { fake, task } = seeded();
    renderApp(`/tasks/${task.id}`, fake);
    await screen.findByRole("button", { name: "Cancelar tarea" });
    expect(screen.queryByRole("button", { name: "Reanudar tarea" })).toBeNull();
  });

  it("a pausable task shows the pause icon button and clicking it pauses it", async () => {
    const { fake, task } = seeded();
    const { user } = renderApp(`/tasks/${task.id}`, fake);
    const button = await screen.findByRole("button", { name: "Pausar tarea" });
    expect(button.querySelector('svg[data-icon="pause"]')).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Reanudar tarea" })).toBeNull();

    await user.click(button);

    expect(await screen.findByText("Paused")).toBeTruthy();
    expect(fake.requests.some((r) => r.path === `/api/tasks/${task.id}/pause`)).toBe(true);
    expect(fake.task(task.id).state).toBe("paused");
    expect(screen.queryByRole("button", { name: "Pausar tarea" })).toBeNull();
  });

  it("a paused task shows the Paused badge and Reanudar tarea with icon, without the pause button", async () => {
    const { fake, task } = seeded();
    fake.transition(task.id, "paused", null, {}, "pause");
    const { user } = renderApp(`/tasks/${task.id}`, fake);
    const button = await screen.findByRole("button", { name: "Reanudar tarea" });
    expect(button.querySelector('svg[data-icon="resume"]')).not.toBeNull();
    expect(screen.getByText("Paused")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pausar tarea" })).toBeNull();
    expect(screen.getByRole("button", { name: "Cancelar tarea" })).toBeTruthy();

    await user.click(button);

    await waitFor(() => expect(fake.task(task.id).state).toBe("draft"));
    expect(fake.requests.some((r) => r.path === `/api/tasks/${task.id}/resume`)).toBe(true);
    expect(await screen.findByRole("button", { name: "Pausar tarea" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reanudar tarea" })).toBeNull();
  });

  it("a task in needs_human offers resuming and not pausing", async () => {
    const { fake, task } = seeded();
    fake.transition(task.id, "needs_human", null);
    renderApp(`/tasks/${task.id}`, fake);
    expect(await screen.findByRole("button", { name: "Reanudar tarea" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pausar tarea" })).toBeNull();
  });

  it("a finished task offers neither pausing nor resuming", async () => {
    const { fake, task } = seeded();
    fake.transition(task.id, "completed", null);
    renderApp(`/tasks/${task.id}`, fake);
    await screen.findByText("Completed");
    expect(screen.queryByRole("button", { name: "Pausar tarea" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reanudar tarea" })).toBeNull();
  });

  it("if the API rejects the pause it shows the error with role alert", async () => {
    const { fake, task } = seeded();
    const { user } = renderApp(`/tasks/${task.id}`, fake);
    const button = await screen.findByRole("button", { name: "Pausar tarea" });
    // The task completed while the screen was still open: the server rejects the pause.
    fake.task(task.id).state = "completed";
    await user.click(button);
    expect((await screen.findByRole("alert")).textContent).toMatch(/pause does not apply/);
  });

  it("warns if the task does not exist", async () => {
    renderApp("/tasks/00000000-0000-4000-8000-000000000999");
    expect(await screen.findByText("La tarea no existe.")).toBeTruthy();
  });
});

describe("#N mentions in the detail's goal", () => {
  it("a mention of an existing task is a link to its detail", async () => {
    const { fake, project, dep } = seeded();
    const task = fake.addTask(project.id, { goal: `Depende de #${dep.number} para arrancar` });
    renderApp(`/tasks/${task.id}`, fake);

    const heading = await screen.findByRole("heading", {
      name: `Depende de #${dep.number} para arrancar`,
    });
    const link = await within(heading).findByRole("link", { name: `#${dep.number}` });
    expect(link).toHaveProperty("href", expect.stringContaining(`/tasks/${dep.id}`));
  });

  it("a nonexistent number, #abc or a#5 are shown as is, without a link", async () => {
    const { fake, project, dep } = seeded();
    // The last mention does exist: when it is a link, the tasks have already loaded.
    const goal = `Ver #999, #abc, a#${dep.number} y #${dep.number}`;
    const task = fake.addTask(project.id, { goal });
    renderApp(`/tasks/${task.id}`, fake);

    const heading = await screen.findByRole("heading", { name: goal });
    await within(heading).findByRole("link", { name: `#${dep.number}` });
    expect(within(heading).getAllByRole("link")).toHaveLength(1);
  });
});

describe("#N mentions in cards and rows that are already a link", () => {
  it("the board and the queue show the goal as plain text, without nested links", async () => {
    const { fake, project, dep } = seeded();
    const goal = `Depende de #${dep.number}`;
    const task = fake.addTask(project.id, { goal });
    fake.queue = [
      {
        task,
        ready: true,
        score: 1,
        effectivePriority: 1,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: null,
        },
      },
    ];
    const board = renderApp(`/projects/${project.id}`, fake);
    const card = await screen.findByRole("link", { name: goal });
    expect(card.querySelector("a")).toBeNull();
    board.unmount();

    renderApp("/queue", fake);
    const row = await screen.findByRole("link", { name: goal });
    expect(row.querySelector("a")).toBeNull();
  });
});
