// UW-21 done criterion: a task is created and followed end to end without using the API by
// hand. The FakeApi acts as scheduler and agents; the human only uses the UI.
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FakeApi } from "./fake-api.ts";
import { renderApp } from "./render.tsx";

const section = async (name: string) => within(await screen.findByRole("region", { name }));

describe("end-to-end flow from the UI", () => {
  it("creates a task, approves its spec and follows it to the PR", async () => {
    const fake = new FakeApi();
    const project = fake.addProject({ name: "lunas-queue" });
    const { user, router, refresh } = renderApp("/queue", fake);

    // Creation from the header's Nueva tarea button.
    await user.click(await screen.findByRole("link", { name: "Nueva tarea" }));
    await user.selectOptions(await screen.findByLabelText("Proyecto"), "lunas-queue");
    await user.type(screen.getByLabelText("Intención"), "Login con email");
    await user.click(screen.getByRole("button", { name: "Crear tarea" }));
    expect(await screen.findByRole("heading", { name: "Login con email" })).toBeTruthy();
    expect(screen.getByText("Draft")).toBeTruthy();
    const taskId = router.state.location.pathname.split("/").at(-1) as string;

    // The scheduler dispatches the refinement and the agent delivers the spec.
    const refine = fake.startRun(taskId, "refine");
    fake.transition(taskId, "draft", "running");
    fake.addSpec(taskId);
    fake.endRun(refine.id, { handoff: { phase: "refinement" } });
    fake.transition(taskId, "refined", null);
    await refresh();
    expect(await screen.findByText("Refined")).toBeTruthy();

    // Human gate: approve the spec from the detail.
    await user.click(await (await section("Spec")).findByRole("button", { name: "Aprobar v1" }));
    expect(await screen.findByText("In progress")).toBeTruthy();

    // Implementation, verification with pass and delivery.
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
    const evidence = await section("Evidencia");
    await user.click(evidence.getByRole("button", { name: "Mostrar evidencia" }));
    expect(await evidence.findByRole("heading", { name: "Run verify" })).toBeTruthy();

    // On the project board it ends up in Completed.
    await user.click(screen.getByRole("link", { name: "lunas-queue" }));
    const completed = within(await screen.findByRole("region", { name: "Completed" }));
    expect(completed.getByRole("link", { name: "Login con email" })).toBeTruthy();
    expect(router.state.location.pathname).toBe(`/projects/${project.id}`);
  });
});
