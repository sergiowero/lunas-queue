import { describe, expect, it } from "vitest";
import { isHerdrError } from "./errors.ts";
import { FakeHerdr } from "./fake.ts";
import type { HerdrEvent } from "./types.ts";

// Controles propios del fake, que usan las unidades que dependen del adapter (dispatcher,
// reconciliación, notificaciones) para provocar lo que en herdr real hace el agente.
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
  it("setAgentStatus emite el cambio y despierta a waitAgent", async () => {
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

  it("exitAgent deja el pane sin agente y emite pane_exited", async () => {
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

  it("startStatus blocked simula el arranque bloqueado por el diálogo de confianza", async () => {
    const fake = new FakeHerdr({ startStatus: "blocked" });
    const { rootPaneId } = await fake.ensureWorkspace({ cwd: "/repo", label: "proj" });
    const { agent, started } = await fake.startAgent({
      name: "t1-refine-1",
      kind: "claude",
      paneId: rootPaneId,
    });
    expect(started).toBe(true);
    expect(agent.status).toBe("blocked");
  });

  it("setAgentSession publica la identidad de sesión del agente", async () => {
    const fake = new FakeHerdr();
    await agentSetup(fake);
    const session = { kind: "id", source: "herdr:claude", value: "uuid-1" };
    fake.setAgentSession("t1-refine-1", session);
    expect((await fake.getAgent("t1-refine-1"))?.session).toEqual(session);
  });

  it("los workspaces de proyecto no publican checkoutPath, como en herdr", async () => {
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

  it("las notificaciones están apagadas por defecto, como en herdr", async () => {
    expect(await new FakeHerdr().notify({ title: "x" })).toEqual({
      shown: false,
      reason: "disabled",
    });
    const fake = new FakeHerdr({ notificationsEnabled: true });
    expect(await fake.notify({ title: "x", body: "y" })).toEqual({ shown: true });
    expect(fake.notifications).toEqual([{ title: "x", body: "y" }]);
  });

  it("ensureWorktree sobre un workspace inexistente falla con workspace_not_found", async () => {
    const err = await new FakeHerdr()
      .ensureWorktree({ workspaceId: "w9", branch: "b", base: "main" })
      .catch((e) => e);
    expect(isHerdrError(err, "workspace_not_found")).toBe(true);
  });
});
