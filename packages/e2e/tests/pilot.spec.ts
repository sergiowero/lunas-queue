// Piloto end-to-end (UW-29): tres tareas con dependencias (A ← B ← C) sobre un repo git real,
// con un rework, una pregunta y hooks por fase. Los humanos hacen desde la UI lo que les toca
// (crear, responder, aprobar la spec); el merge lo hace el test, como lo haría GitHub.
import { expect, type Page, test } from "@playwright/test";

const CONTROL = `http://127.0.0.1:${process.env.E2E_CONTROL_PORT ?? 7462}`;

const A = "Cancelar pedidos pendientes [pregunta]";
const B = "Listar los pedidos cancelados [rework]";
const C = "Exportar los pedidos cancelados a CSV";

interface TaskView {
  id: string;
  intent: string;
  state: string;
  subState: string | null;
  verificationIteration: number;
  prUrl: string | null;
  prState: string | null;
}

async function control<T>(path: string, method = "GET"): Promise<T> {
  const res = await fetch(`${CONTROL}${path}`, { method });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

async function tasks(page: Page): Promise<TaskView[]> {
  const res = await page.request.get("/api/tasks");
  return (await res.json()) as TaskView[];
}

async function taskId(page: Page, intent: string): Promise<string> {
  const task = (await tasks(page)).find((t) => t.intent === intent);
  if (!task) throw new Error(`no existe la tarea «${intent}»`);
  return task.id;
}

async function createTask(page: Page, intent: string, dependsOn: string[] = []) {
  await page.goto("/tasks/new");
  await page.getByLabel("Proyecto").selectOption({ label: "Piloto" });
  await page.getByLabel("Intent").fill(intent);
  for (const dependency of dependsOn) await page.getByLabel(dependency).check();
  await page.getByRole("button", { name: "Crear tarea" }).click();
  await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { level: 1, name: intent })).toBeVisible();
}

/** Aprueba desde la bandeja la spec que entregó el refinamiento de la tarea. */
async function approveSpec(page: Page, intent: string) {
  await page.goto("/inbox");
  const item = page.getByRole("article", { name: intent });
  await expect(item).toBeVisible();
  await item.getByRole("button", { name: /^Aprobar v\d+$/ }).click();
  await expect(item).toBeHidden();
}

/** La tarea espera su dependencia: tras varios ticks del scheduler sigue en draft y sin Runs. */
async function expectBlocked(page: Page, id: string) {
  await page.waitForTimeout(3_500);
  const task = (await tasks(page)).find((t) => t.id === id) as TaskView;
  expect(task.state).toBe("draft");
  const runs = (await (await page.request.get(`/api/tasks/${id}/runs`)).json()) as unknown[];
  expect(runs).toEqual([]);
}

async function waitForState(page: Page, id: string, predicate: (t: TaskView) => boolean) {
  await expect
    .poll(async () => predicate((await tasks(page)).find((t) => t.id === id) as TaskView), {
      timeout: 60_000,
    })
    .toBe(true);
}

test.describe.configure({ mode: "serial" });

test.describe("piloto", () => {
  test("crea tres tareas con dependencias desde la UI", async ({ page }) => {
    await createTask(page, A);
    await createTask(page, B, [A]);
    await createTask(page, C, [B]);

    await page.goto("/dag");
    await expect(page.getByRole("heading", { name: "Dependencias entre tareas" })).toBeVisible();
    const graph = page.getByLabel("Grafo de dependencias");
    for (const intent of [A, B, C]) await expect(graph.getByText(intent)).toBeVisible();

    const b = await taskId(page, B);
    await page.goto(`/tasks/${b}`);
    await expect(page.getByText("Depende de")).toBeVisible();
    await expect(page.getByRole("link", { name: A })).toBeVisible();
  });

  test("A: el refinamiento pregunta, el humano responde y aprueba la spec", async ({ page }) => {
    await page.goto("/inbox");
    const question = page.getByRole("article", { name: A });
    await expect(
      question.getByText("¿La cancelación debe notificar al cliente por correo?"),
    ).toBeVisible();
    await question.getByLabel("Respuesta").fill("Sí, con un correo al confirmar la cancelación.");
    await question.getByRole("button", { name: "Responder" }).click();

    await approveSpec(page, A);
    const a = await taskId(page, A);
    await page.goto(`/tasks/${a}`);
    // La pregunta y su respuesta quedan en el Event log de la tarea.
    const log = page.getByRole("region", { name: "Event log" });
    await expect(log).toContainText("question.created");
    await expect(log).toContainText("question.answered");
  });

  test("A: se implementa, verifica y entrega como PR", async ({ page }) => {
    const a = await taskId(page, A);
    await waitForState(page, a, (t) => t.state === "completed" && t.prUrl !== null);

    await page.goto(`/tasks/${a}`);
    await expect(
      page.getByRole("link", { name: "https://github.com/acme/piloto/pull/1" }),
    ).toBeVisible();
    for (const phase of ["Refinamiento", "Implementación", "Verificación"]) {
      await expect(
        page.getByRole("region", { name: "Runs" }).getByText(phase).first(),
      ).toBeVisible();
    }
    // El archivo de evidencia lleva el veredicto del verificador y los criterios.
    const evidence = page.getByRole("region", { name: "Evidencia" });
    await expect(evidence).toContainText(`lunasq/tasks/${a}.md`);
    await expect(evidence).toContainText("Veredicto: pass");
    await expect(evidence).toContainText("AC-1");
  });

  test("los hooks por fase de A quedan en la vista de hooks", async ({ page }) => {
    await page.goto("/projects");
    await page.getByRole("link", { name: "Piloto" }).click();
    await page.getByRole("link", { name: /Hooks/ }).click();

    const prepare = page.getByLabel("10-prepare.sh");
    await expect(prepare).toContainText("exit 0");
    await expect(prepare).toContainText("preparando");
    await expect(prepare).toContainText("lunasq/");
    // `warn`: el lint falla (exit 1) pero la fase sigue: A ya llegó a completed en el test anterior.
    await expect(page.getByLabel("10-lint.sh")).toContainText("exit 1");
    await expect(page.getByLabel("10-lint.sh")).toContainText("warn");
  });

  test("B espera el merge de A y luego pasa por un rework", async ({ page }) => {
    const [a, b] = await Promise.all([taskId(page, A), taskId(page, B)]);
    await expectBlocked(page, b);

    await control(`/merge/${a}`, "POST");
    await waitForState(page, a, (t) => t.prState === "merged");

    await approveSpec(page, B);
    await waitForState(page, b, (t) => t.state === "completed" && t.prUrl !== null);

    await page.goto(`/tasks/${b}`);
    // El primer veredicto fue reject: una iteración de verificación y dos Runs de implementación.
    await expect(page.getByText("Iteración de verificación").locator("..")).toContainText("1");
    const runs = page.getByRole("region", { name: "Runs" });
    await expect(runs.getByRole("cell", { name: "Implementación", exact: true })).toHaveCount(2);
    await expect(runs.getByRole("cell", { name: "Verificación", exact: true })).toHaveCount(2);
  });

  test("C llega al final y todo queda mergeado", async ({ page }) => {
    const [b, c] = await Promise.all([taskId(page, B), taskId(page, C)]);
    await expectBlocked(page, c);
    await control(`/merge/${b}`, "POST");
    await approveSpec(page, C);
    await waitForState(page, c, (t) => t.state === "completed" && t.prUrl !== null);
    await control(`/merge/${c}`, "POST");

    for (const id of await Promise.all([A, B, C].map((intent) => taskId(page, intent)))) {
      await waitForState(page, id, (t) => t.state === "completed" && t.prState === "merged");
    }

    // after_merge corrió una vez por PR mergeado: cada tarea lo deja en su Event log.
    for (const id of await Promise.all([A, B, C].map((intent) => taskId(page, intent)))) {
      await expect
        .poll(async () => {
          const res = await page.request.get(`/api/tasks/${id}/events`);
          const events = (await res.json()) as { type: string; payload: { point?: string } }[];
          return events.filter(
            (e) => e.type === "hook.executed" && e.payload.point === "after_merge",
          ).length;
        })
        .toBe(1);
    }
    const { projectId } = await control<{ projectId: string }>("/state");
    await page.goto(`/projects/${projectId}/hooks`);
    await expect(page.getByLabel("10-announce.sh")).toContainText("mergeado https://github.com/");

    await page.goto("/queue");
    await expect(page.getByRole("heading", { name: "Cola global" })).toBeVisible();
    const { errors } = await control<{ errors: string[] }>("/state");
    expect(errors).toEqual([]);
  });
});
