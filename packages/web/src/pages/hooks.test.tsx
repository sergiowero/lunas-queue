import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FakeApi } from "../../test/fake-api.ts";
import { renderApp } from "../../test/render.tsx";

const sha = "a1b2c3d4".repeat(5);

function setup() {
  const fake = new FakeApi();
  const project = fake.addProject({ name: "lunas-queue" });
  fake.hooks.set(project.id, {
    baseRef: sha,
    configError: null,
    points: [
      { point: "before_refinement", hooks: [] },
      {
        point: "before_delivery",
        hooks: [
          {
            script: "10-bump-version",
            policy: "warn",
            timeoutSeconds: 300,
            content: "#!/bin/sh\nnpm version patch\n",
          },
          {
            script: "20-changelog",
            policy: "block",
            timeoutSeconds: 600,
            content: "#!/bin/sh\necho changelog\n",
          },
        ],
      },
      { point: "after_merge", hooks: [] },
    ],
  });
  const task = fake.addTask(project.id, { intent: "Subir versión" });
  return { fake, project, task };
}

function execution(
  fake: FakeApi,
  taskId: string,
  eventId: number,
  over: Record<string, unknown> = {},
) {
  fake.hookExecutions.unshift({
    eventId,
    taskId,
    taskIntent: fake.task(taskId).intent,
    at: new Date(Date.UTC(2026, 9, 29, 12, eventId)).toISOString(),
    point: "before_delivery",
    script: "10-bump-version",
    baseRef: sha,
    runId: null,
    policy: "warn",
    timeoutSeconds: 300,
    exitCode: 0,
    timedOut: false,
    durationMs: 1500,
    passed: true,
    output: "v1.2.3",
    ...over,
  } as never);
}

describe("vista de hooks", () => {
  it("muestra por punto los hooks de la rama base con su contenido, política y timeout", async () => {
    const { fake, project } = setup();
    renderApp(`/projects/${project.id}/hooks`, fake);

    expect(await screen.findByRole("heading", { name: /Hooks · lunas-queue/ })).toBeTruthy();
    const point = within(await screen.findByRole("region", { name: "before_delivery" }));
    const bump = within(point.getByRole("group", { name: "10-bump-version" }));
    expect(bump.getByText("warn")).toBeTruthy();
    expect(bump.getByText("5 min")).toBeTruthy();
    expect(bump.getByText(/npm version patch/)).toBeTruthy();
    const changelog = within(point.getByRole("group", { name: "20-changelog" }));
    expect(changelog.getByText("block")).toBeTruthy();
    expect(changelog.getByText("10 min")).toBeTruthy();
    // Los scripts salen en el orden en que corren.
    expect(point.getAllByRole("group").map((g) => g.getAttribute("aria-label"))).toEqual([
      "10-bump-version",
      "20-changelog",
    ]);
    expect(screen.getByText(sha.slice(0, 7))).toBeTruthy();
  });

  it("muestra las últimas ejecuciones por tarea con código de salida, duración y salida", async () => {
    const { fake, project, task } = setup();
    const other = fake.addTask(project.id, { intent: "Otra tarea" });
    execution(fake, task.id, 1, { exitCode: 1, passed: false, output: "falló el bump" });
    execution(fake, task.id, 2, { output: "v1.2.3" });
    execution(fake, other.id, 3, {
      exitCode: 124,
      timedOut: true,
      passed: false,
      durationMs: 300000,
      output: "",
    });
    renderApp(`/projects/${project.id}/hooks`, fake);

    const bump = within(await screen.findByRole("group", { name: "10-bump-version" }));
    const rows = bump.getAllByRole("row").slice(1);
    // Una fila por tarea, la más reciente de cada una.
    expect(rows).toHaveLength(2);
    const [first, second] = rows.map((r) => within(r));
    expect(first?.getByRole("link", { name: "Otra tarea" })).toBeTruthy();
    expect(first?.getByText(/timeout/)).toBeTruthy();
    expect(first?.getByText("5 min")).toBeTruthy();
    expect(second?.getByRole("link", { name: "Subir versión" })).toHaveProperty(
      "href",
      expect.stringContaining(`/tasks/${task.id}`),
    );
    expect(second?.getByText("exit 0")).toBeTruthy();
    expect(second?.getByText("1,5 s")).toBeTruthy();
    expect(second?.getByText("v1.2.3")).toBeTruthy();
    expect(bump.queryByText("falló el bump")).toBeNull();
  });

  it("dice cuando un hook aún no se ha ejecutado y cuando un punto no tiene hooks", async () => {
    const { fake, project } = setup();
    renderApp(`/projects/${project.id}/hooks`, fake);
    const changelog = within(await screen.findByRole("group", { name: "20-changelog" }));
    expect(changelog.getByText("Sin ejecuciones.")).toBeTruthy();
    expect(screen.getByText(/Sin hooks: before_refinement, after_merge/)).toBeTruthy();
  });

  it("muestra las ejecuciones de un script que ya no está en la rama base", async () => {
    const { fake, project, task } = setup();
    execution(fake, task.id, 1, { script: "99-viejo" });
    renderApp(`/projects/${project.id}/hooks`, fake);
    const old = within(await screen.findByRole("group", { name: "99-viejo" }));
    expect(old.getByText("ya no está en la rama base")).toBeTruthy();
    expect(old.getByRole("link", { name: "Subir versión" })).toBeTruthy();
  });

  it("avisa de un error en lunasq/hooks/config", async () => {
    const { fake, project } = setup();
    const hooks = fake.hooks.get(project.id);
    if (hooks) hooks.configError = "lunasq/hooks/config no es JSON";
    renderApp(`/projects/${project.id}/hooks`, fake);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "lunasq/hooks/config no es JSON",
    );
  });

  it("no dice «Sin ejecuciones» si la consulta de ejecuciones falla", async () => {
    const { fake, project } = setup();
    fake.hookExecutionsFail = true;
    renderApp(`/projects/${project.id}/hooks`, fake);
    const bump = within(await screen.findByRole("group", { name: "10-bump-version" }));
    expect(await bump.findByText("No se pudieron cargar las ejecuciones.")).toBeTruthy();
    expect(screen.queryByText("Sin ejecuciones.")).toBeNull();
    expect(bump.getByText(/npm version patch/)).toBeTruthy();
  });

  it("pide un máximo de tareas por hook y muestra la ejecución de un hook poco frecuente", async () => {
    const { fake, project, task } = setup();
    execution(fake, task.id, 1, { point: "after_merge", script: "deploy" });
    for (let i = 0; i < 12; i++) {
      const t = fake.addTask(project.id, { intent: `Tarea ${i}` });
      execution(fake, t.id, 10 + i);
    }
    const hooks = fake.hooks.get(project.id);
    hooks?.points[2]?.hooks.push({
      script: "deploy",
      policy: "block",
      timeoutSeconds: 600,
      content: "#!/bin/sh\necho deploy\n",
    });
    renderApp(`/projects/${project.id}/hooks`, fake);
    const deploy = within(await screen.findByRole("group", { name: "deploy" }));
    expect(await deploy.findByRole("link", { name: "Subir versión" })).toBeTruthy();
    const bump = within(screen.getByRole("group", { name: "10-bump-version" }));
    expect(bump.getAllByRole("row")).toHaveLength(1 + 10);
  });

  it("muestra el error cuando no se puede leer la rama base", async () => {
    const fake = new FakeApi();
    const project = fake.addProject();
    renderApp(`/projects/${project.id}/hooks`, fake);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "no se pudo leer la rama base",
    );
  });
});
