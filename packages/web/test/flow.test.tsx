// Criterio de terminado de UW-21: una tarea se crea y se sigue de punta a punta sin usar la API a
// mano. El FakeApi hace de scheduler y de agentes; el humano solo usa la UI.
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FakeApi } from "./fake-api.ts";
import { renderApp } from "./render.tsx";

const section = async (name: string) => within(await screen.findByRole("region", { name }));

describe("flujo de punta a punta desde la UI", () => {
  it("crea una tarea, aprueba su spec y la sigue hasta el PR", async () => {
    const fake = new FakeApi();
    const project = fake.addProject({ name: "lunas-queue" });
    const { user, router, refresh } = renderApp("/queue", fake);

    // Alta desde la navegación.
    await user.click(await screen.findByRole("link", { name: "Nueva tarea" }));
    await user.selectOptions(await screen.findByLabelText("Proyecto"), "lunas-queue");
    await user.type(screen.getByLabelText("Intent"), "Login con email");
    await user.click(screen.getByRole("button", { name: "Crear tarea" }));
    expect(await screen.findByRole("heading", { name: "Login con email" })).toBeTruthy();
    expect(screen.getByText("Draft")).toBeTruthy();
    const taskId = router.state.location.pathname.split("/").at(-1) as string;

    // El scheduler despacha el refinamiento y el agente entrega la spec.
    const refine = fake.startRun(taskId, "refine");
    fake.transition(taskId, "draft", "running");
    fake.addSpec(taskId);
    fake.endRun(refine.id, { handoff: { phase: "refinement" } });
    fake.transition(taskId, "refined", null);
    await refresh();
    expect(await screen.findByText("Refined")).toBeTruthy();

    // Gate humano: aprobar la spec desde el detalle.
    await user.click(await (await section("Spec")).findByRole("button", { name: "Aprobar v1" }));
    expect(await screen.findByText("In progress")).toBeTruthy();

    // Implementación, verificación con pass y entrega.
    const implement = fake.startRun(taskId, "implement");
    fake.transition(taskId, "in_progress", "running", { branch: "lunasq/login" });
    fake.endRun(implement.id, {});
    fake.transition(taskId, "verification", "queued");
    const verify = fake.startRun(taskId, "verify");
    fake.endRun(verify.id, { handoff: { verdict: "pass" } });
    fake.transition(taskId, "completed", null, {
      prUrl: "https://github.com/sergiowero/lunas-queue/pull/42",
      prState: "open",
      worktreePath: "/w/login",
    });
    fake.evidence.set(taskId, "# Evidencia\n\n## Run verify\n\nVeredicto: pass");
    await refresh();

    expect(await screen.findByText("Completed")).toBeTruthy();
    expect(screen.getByRole("link", { name: /pull\/42/ })).toBeTruthy();
    const runs = await section("Runs");
    await waitFor(() => expect(runs.getAllByRole("row")).toHaveLength(4));
    expect(
      (await section("Event log")).getByText("Verification · en cola → Completed"),
    ).toBeTruthy();
    expect(
      await (await section("Evidencia")).findByRole("heading", { name: "Run verify" }),
    ).toBeTruthy();

    // En el tablero del proyecto queda en Completed.
    await user.click(screen.getByRole("link", { name: "lunas-queue" }));
    const completed = within(await screen.findByRole("region", { name: "Completed" }));
    expect(completed.getByRole("link", { name: "Login con email" })).toBeTruthy();
    expect(router.state.location.pathname).toBe(`/projects/${project.id}`);
  });
});
