// End-to-end pilot: three tasks with dependencies (A ← B ← C) on a real git repo,
// with a rework, a question and per-phase hooks. Humans do from the UI what falls to them
// (create, answer, approve the spec); the merge is done by the test, as GitHub would.
import { expect, type Page, test } from "@playwright/test";

const CONTROL = `http://127.0.0.1:${process.env.E2E_CONTROL_PORT ?? 7462}`;

const A = "Cancelar pedidos pendientes [pregunta]";
const B = "Listar los pedidos cancelados [rework]";
const C = "Exportar los pedidos cancelados a CSV";

interface TaskView {
  id: string;
  goal: string;
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

async function taskId(page: Page, goal: string): Promise<string> {
  const task = (await tasks(page)).find((t) => t.goal === goal);
  if (!task) throw new Error(`task «${goal}» does not exist`);
  return task.id;
}

async function createTask(page: Page, goal: string, dependsOn: string[] = []) {
  await page.goto("/tasks/new");
  await page.getByLabel("Proyecto").selectOption({ label: "Piloto" });
  await page.getByLabel("Objetivo").fill(goal);
  for (const dependency of dependsOn) {
    await page.getByLabel("Depende de").selectOption({ value: await taskId(page, dependency) });
    await expect(
      page
        .getByRole("list", { name: "Dependencias elegidas" })
        .getByText(dependency, { exact: true }),
    ).toBeVisible();
  }
  await page.getByRole("button", { name: "Crear tarea" }).click();
  await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { level: 1, name: goal })).toBeVisible();
}

/** From the task detail, approves the spec the refinement delivered; the inbox only links. */
async function approveSpec(page: Page, goal: string) {
  const id = await taskId(page, goal);
  await page.goto("/inbox");
  await expect(page.getByRole("link", { name: goal })).toBeVisible();
  await page.goto(`/tasks/${id}`);
  await page.getByRole("button", { name: /^Aprobar v\d+$/ }).click();
  await waitForState(page, id, (t) => t.state !== "refined");
  await page.goto("/inbox");
  await expect(page.getByRole("link", { name: goal })).toBeHidden();
}

/** The task waits for its dependency: after several scheduler ticks it is still in draft and without Runs. */
async function expectBlocked(page: Page, id: string) {
  await page.waitForTimeout(3_500);
  const task = (await tasks(page)).find((t) => t.id === id) as TaskView;
  expect(task.state).toBe("draft");
  const runs = (await (await page.request.get(`/api/tasks/${id}/runs`)).json()) as unknown[];
  expect(runs).toEqual([]);
}

async function waitForState(page: Page, id: string, predicate: (t: TaskView) => boolean) {
  try {
    await expect
      .poll(async () => predicate((await tasks(page)).find((t) => t.id === id) as TaskView), {
        timeout: 60_000,
      })
      .toBe(true);
  } catch (error) {
    // Without this a CI failure only says «false»: add where the task ended up and what the server recorded.
    const task = (await tasks(page)).find((t) => t.id === id);
    const { errors } = await control<{ errors: string[] }>("/state");
    const events = (await (await page.request.get(`/api/tasks/${id}/events`)).json()) as {
      type: string;
      payload: unknown;
    }[];
    const tail = events
      .slice(-4)
      .map((e) => `${e.type} ${JSON.stringify(e.payload).slice(0, 300)}`);
    throw new Error(
      `${error instanceof Error ? error.message : error}\ntarea: ${task?.state}/${task?.subState}\nservidor: ${errors.join(" | ") || "sin errores"}\n${tail.join("\n")}`,
    );
  }
}

test.describe.configure({ mode: "serial" });

test.describe("pilot", () => {
  test("creates tasks with dependencies from the UI and shows them in the detail", async ({
    page,
  }) => {
    await createTask(page, A);
    await createTask(page, B, [A]);
    await createTask(page, C, [B]);

    const b = await taskId(page, B);
    await page.goto(`/tasks/${b}`);
    await expect(page.getByText("Depende de")).toBeVisible();
    await expect(page.getByRole("link", { name: A })).toBeVisible();
  });

  test("A: refinement asks, the human answers and approves the spec", async ({ page }) => {
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
    // The question and its answer stay in the task's Event log.
    const log = page.getByRole("region", { name: "Event log" });
    await expect(log).toContainText("question.created");
    await expect(log).toContainText("question.answered");
  });

  test("A: is implemented, verified and delivered as a PR", async ({ page }) => {
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
    // The evidence file carries the verifier's verdict and the criteria.
    const evidence = page.getByRole("region", { name: "Evidencia" });
    await evidence.getByRole("button", { name: "Evidencia" }).click();
    await expect(evidence).toContainText(`lunasq/tasks/${a}.md`);
    await expect(evidence).toContainText("Verdict: pass");
    await expect(evidence).toContainText("AC-1");
  });

  test("A's per-phase hooks show up in the hooks view", async ({ page }) => {
    await page.goto("/projects");
    await page.getByRole("link", { name: "Piloto" }).click();
    await page.getByRole("link", { name: /Hooks/ }).click();

    const prepare = page.getByLabel("10-prepare.sh");
    await expect(prepare).toContainText("exit 0");
    await expect(prepare).toContainText("preparing");
    await expect(prepare).toContainText("lunasq/");
    // `warn`: lint fails (exit 1) but the phase continues: A already reached completed in the previous test.
    await expect(page.getByLabel("10-lint.sh")).toContainText("exit 1");
    await expect(page.getByLabel("10-lint.sh")).toContainText("warn");
  });

  test("B waits for A's merge and then goes through a rework", async ({ page }) => {
    const [a, b] = await Promise.all([taskId(page, A), taskId(page, B)]);
    await expectBlocked(page, b);

    await control(`/merge/${a}`, "POST");
    await waitForState(page, a, (t) => t.prState === "merged");

    await approveSpec(page, B);
    await waitForState(page, b, (t) => t.state === "completed" && t.prUrl !== null);

    await page.goto(`/tasks/${b}`);
    // The first verdict was reject: one verification iteration and two implementation Runs.
    await expect(page.getByText("Iteración de verificación").locator("..")).toContainText("1");
    const runs = page.getByRole("region", { name: "Runs" });
    await expect(runs.getByRole("cell", { name: "Implementación", exact: true })).toHaveCount(2);
    await expect(runs.getByRole("cell", { name: "Verificación", exact: true })).toHaveCount(2);
  });

  test("C reaches the end and everything ends up merged", async ({ page }) => {
    const [b, c] = await Promise.all([taskId(page, B), taskId(page, C)]);
    await expectBlocked(page, c);
    await control(`/merge/${b}`, "POST");
    await approveSpec(page, C);
    await waitForState(page, c, (t) => t.state === "completed" && t.prUrl !== null);
    await control(`/merge/${c}`, "POST");

    for (const id of await Promise.all([A, B, C].map((goal) => taskId(page, goal)))) {
      await waitForState(page, id, (t) => t.state === "completed" && t.prState === "merged");
    }

    // after_merge ran once per merged PR: each task leaves it in its Event log.
    for (const id of await Promise.all([A, B, C].map((goal) => taskId(page, goal)))) {
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
    await expect(page.getByLabel("10-announce.sh")).toContainText("merged https://github.com/");

    await page.goto("/queue");
    await expect(page.getByRole("heading", { name: "Cola global" })).toBeVisible();
    const { errors } = await control<{ errors: string[] }>("/state");
    expect(errors).toEqual([]);
  });
});
