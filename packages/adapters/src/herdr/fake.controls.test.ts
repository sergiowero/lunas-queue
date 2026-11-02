import { describe, expect, it } from "vitest";
import { TRUST_DIALOG_MARKER } from "./claude-tui.ts";
import { isHerdrError } from "./errors.ts";
import { FakeHerdr } from "./fake.ts";
import type { HerdrEvent } from "./types.ts";

// The fake's own controls, used by the units that depend on the adapter (dispatcher,
// reconciliation, notifications) to cause what the agent does in real herdr.
async function agentSetup(fake: FakeHerdr) {
  const { rootPaneId } = await fake.ensureWorkspace({ cwd: "/repo", label: "proj" });
  const pane = await fake.splitPane({ paneId: rootPaneId });
  await fake.startAgent({ name: "t1-refine-1", kind: "claude", paneId: pane.paneId });
  const events: HerdrEvent[] = [];
  fake.subscribe({ paneIds: [pane.paneId], lifecycle: true }, (e) => events.push(e));
  return { pane, events };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("FakeHerdr: controles de test", () => {
  it("setAgentStatus emits the change and wakes waitAgent", async () => {
    const fake = new FakeHerdr();
    const { pane, events } = await agentSetup(fake);
    const waiting = fake.waitAgent({ name: "t1-refine-1", until: ["blocked"], timeoutMs: 1_000 });
    fake.setAgentStatus("t1-refine-1", "blocked");
    expect((await waiting).status).toBe("blocked");
    await flush();
    expect(events).toContainEqual({
      type: "agent_status_changed",
      paneId: pane.paneId,
      workspaceId: pane.workspaceId,
      status: "blocked",
    });
  });

  it("exitAgent leaves the pane without an agent and emits pane_exited", async () => {
    const fake = new FakeHerdr();
    const { pane, events } = await agentSetup(fake);
    fake.exitAgent("t1-refine-1");
    await flush();
    expect(await fake.getAgent("t1-refine-1")).toBeUndefined();
    expect(events).toContainEqual({
      type: "pane_exited",
      paneId: pane.paneId,
      workspaceId: pane.workspaceId,
    });
    expect((await fake.snapshot()).panes.map((p) => p.paneId)).toContain(pane.paneId);
  });

  it("startStatus blocked simulates the start blocked by the trust dialog", async () => {
    const fake = new FakeHerdr({ startStatus: "blocked" });
    const { rootPaneId } = await fake.ensureWorkspace({ cwd: "/repo", label: "proj" });
    const { agent, started } = await fake.startAgent({
      name: "t1-refine-1",
      kind: "claude",
      paneId: rootPaneId,
    });
    expect(started).toBe(true);
    expect(agent.status).toBe("blocked");
    expect(await fake.readAgent({ name: "t1-refine-1" })).toContain(TRUST_DIALOG_MARKER);
  });

  it("down enter accepts the trust dialog and the agent ends up idle", async () => {
    const fake = new FakeHerdr({ startStatus: "blocked" });
    const { rootPaneId } = await fake.ensureWorkspace({ cwd: "/repo", label: "proj" });
    await fake.startAgent({ name: "t1-refine-1", kind: "claude", paneId: rootPaneId });
    await fake.sendKeys({ name: "t1-refine-1", keys: ["down", "enter"] });
    expect((await fake.getAgent("t1-refine-1"))?.status).toBe("idle");
    expect(await fake.readAgent({ name: "t1-refine-1" })).not.toContain(TRUST_DIALOG_MARKER);
  });

  it("a bare enter picks 'No, exit' and the agent ends, like Claude Code", async () => {
    const fake = new FakeHerdr({ startStatus: "blocked" });
    const { rootPaneId } = await fake.ensureWorkspace({ cwd: "/repo", label: "proj" });
    await fake.startAgent({ name: "t1-refine-1", kind: "claude", paneId: rootPaneId });
    await fake.sendKeys({ name: "t1-refine-1", keys: ["enter"] });
    expect(await fake.getAgent("t1-refine-1")).toBeUndefined();
  });

  it("stores the args and the keys received so tests can inspect them", async () => {
    const fake = new FakeHerdr();
    const { rootPaneId } = await fake.ensureWorkspace({ cwd: "/repo", label: "proj", env: {} });
    const pane = await fake.splitPane({ paneId: rootPaneId, env: { A: "1" } });
    await fake.startAgent({ name: "a", kind: "claude", paneId: pane.paneId, args: ["--x"] });
    await fake.sendKeys({ name: "a", keys: ["enter"] });
    expect(fake.agentArgs("a")).toEqual(["--x"]);
    expect(fake.paneEnv(pane.paneId)).toEqual({ A: "1" });
    expect(fake.sentKeys("a")).toEqual([["enter"]]);
  });

  it("setAgentSession publishes the agent's session identity", async () => {
    const fake = new FakeHerdr();
    await agentSetup(fake);
    const session = { kind: "id", source: "herdr:claude", value: "uuid-1" };
    fake.setAgentSession("t1-refine-1", session);
    expect((await fake.getAgent("t1-refine-1"))?.session).toEqual(session);
  });

  it("setAgentScreen sets what readAgent returns, until it is cleared with undefined", async () => {
    const fake = new FakeHerdr();
    await agentSetup(fake);
    fake.setAgentScreen("t1-refine-1", "Usage limit reached · limit resets 3:45pm");
    expect(await fake.readAgent({ name: "t1-refine-1" })).toBe(
      "Usage limit reached · limit resets 3:45pm",
    );
    fake.setAgentScreen("t1-refine-1", undefined);
    expect(await fake.readAgent({ name: "t1-refine-1", lines: 10 })).not.toContain(
      "Usage limit reached",
    );
  });

  it("project workspaces do not publish checkoutPath, like in herdr", async () => {
    const fake = new FakeHerdr();
    const { workspace } = await fake.ensureWorkspace({ cwd: "/repo", label: "proj" });
    expect(workspace.checkoutPath).toBeUndefined();
    const { worktree } = await fake.ensureWorktree({
      workspaceId: workspace.workspaceId,
      branch: "lunasq/t1",
      base: "main",
      path: "/wt/t1",
    });
    const snap = await fake.snapshot();
    expect(snap.workspaces.find((w) => w.workspaceId === worktree.workspaceId)?.checkoutPath).toBe(
      "/wt/t1",
    );
  });

  it("notifications are off by default, like in herdr", async () => {
    expect(await new FakeHerdr().notify({ title: "x" })).toEqual({
      shown: false,
      reason: "disabled",
    });
    const fake = new FakeHerdr({ notificationsEnabled: true });
    expect(await fake.notify({ title: "x", body: "y" })).toEqual({ shown: true });
    expect(fake.notifications).toEqual([{ title: "x", body: "y" }]);
  });

  it("ensureWorktree on a nonexistent workspace fails with workspace_not_found", async () => {
    const err = await new FakeHerdr()
      .ensureWorktree({ workspaceId: "w9", branch: "b", base: "main" })
      .catch((e) => e);
    expect(isHerdrError(err, "workspace_not_found")).toBe(true);
  });

  it("setWorktreeDirty requires force to remove it, like real herdr", async () => {
    const fake = new FakeHerdr();
    const { workspace } = await fake.ensureWorkspace({ cwd: "/repo", label: "proj" });
    const input = { workspaceId: workspace.workspaceId, branch: "lunasq/t1", base: "main" };
    const { worktree } = await fake.ensureWorktree(input);

    fake.setWorktreeDirty(worktree.path);
    const err = await fake.removeWorktree({ workspaceId: worktree.workspaceId }).catch((e) => e);
    expect(isHerdrError(err, "dirty_worktree_requires_force")).toBe(true);
    expect(await fake.listWorktrees(workspace.workspaceId)).toHaveLength(1);

    await fake.removeWorktree({ workspaceId: worktree.workspaceId, force: true });
    expect(await fake.listWorktrees(workspace.workspaceId)).toEqual([]);
    // The new checkout of the same branch is born clean.
    const again = await fake.ensureWorktree(input);
    await fake.removeWorktree({ workspaceId: again.worktree.workspaceId });
  });
});
