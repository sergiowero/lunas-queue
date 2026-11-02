// End-to-end criterion: the LunasQ MCP with the real gate (FakeHerdr pane, which
// actually executes, over a real git repo). A red suite blocks the transition even if the agent's
// handoff maps each criterion to tests it claims are green.
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeHerdr, HerdrPaneRunner, RealGit } from "@lunasq/adapters";
import { listEvents, RunRepository } from "@lunasq/db";
import { TEST_GATE_EXECUTED } from "@lunasq/schemas";
import { afterEach, describe, expect, it } from "vitest";
import { handoffFor, mcpHarness } from "../mcp/test-helpers.ts";
import { PaneTestGate } from "./gate.ts";

const implementing = { state: "in_progress", subState: "running" } as const;
const verifying = { state: "verification", subState: "running" } as const;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Worktree with a suite that fails until `fixed` exists. */
async function harness() {
  const wt = realpathSync(mkdtempSync(join(tmpdir(), "lunasq-gate-mcp-")));
  dirs.push(wt);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: wt });
  const herdr = new FakeHerdr();
  const { workspace, rootPaneId } = await herdr.ensureWorkspace({ cwd: wt, label: "wt" });
  const h = mcpHarness({
    worktreePath: wt,
    testCommand: `test -f fixed || { echo "FAIL order.test.ts"; exit 1; }; echo "2 passed"`,
    testGate: (db) =>
      new PaneTestGate({
        db,
        git: new RealGit(),
        worktrees: {
          ensure: async () => ({
            branch: "lunasq/t",
            path: wt,
            workspaceId: workspace.workspaceId,
            rootPaneId,
            created: false,
          }),
        },
        runnerFor: (paneId) =>
          new HerdrPaneRunner({ herdr, parentPaneId: paneId, pollMs: 10, paneCheckMs: 50 }),
      }),
  });
  const gateEvents = (taskId: string) =>
    listEvents(h.db, taskId)
      .filter((e) => e.type === TEST_GATE_EXECUTED)
      .map((e) => e.payload as { trigger: string; passed: boolean; output: string });
  return { ...h, wt, gateEvents, fix: () => writeFileSync(join(wt, "fixed"), "") };
}

describe("test gate in the LunasQ MCP", () => {
  it("submit_for_verification with the real suite red does not transition; with it green, it does", async () => {
    const h = await harness();
    const { task, run, call } = await h.ready("implement", implementing);
    const handoff = handoffFor("implementation", run);

    const red = await call("submit_for_verification", { handoff });
    expect(red).toMatchObject({
      isError: true,
      body: { error: "test_gate_failed", output: "FAIL order.test.ts\n" },
    });
    expect(h.taskOf(task.id)).toMatchObject(implementing);
    expect(new RunRepository(h.db).get(run.id)?.endedAt).toBeNull();

    h.fix();
    const green = await call("submit_for_verification", { handoff });
    expect(green).toEqual({ isError: false, body: { state: "verification" } });
    expect(h.gateEvents(task.id)).toMatchObject([
      { trigger: "submit_for_verification", passed: false, output: "FAIL order.test.ts\n" },
      { trigger: "submit_for_verification", passed: true, output: "2 passed\n" },
    ]);
  });

  it("a pass with the real suite red is not accepted", async () => {
    const h = await harness();
    const { task, run, call } = await h.ready("verify", verifying);
    const result = await call("submit_verdict", {
      handoff: h.verdictFor("verification-pass", run),
    });
    expect(result.body).toMatchObject({ error: "test_gate_failed" });
    expect(new RunRepository(h.db).get(run.id)?.handoff).toBeNull();
    // The first is the green gate of the submit_for_verification the task arrives with.
    expect(h.gateEvents(task.id)).toMatchObject([
      { trigger: "submit_for_verification", passed: true },
      { trigger: "verdict_pass", passed: false, output: "FAIL order.test.ts\n" },
    ]);
  });
});
