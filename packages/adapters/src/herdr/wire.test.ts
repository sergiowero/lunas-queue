import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { normalizePath, snapshotWire, toAgent, toEvent, toSnapshot } from "./wire.ts";

describe("traducción del protocolo de herdr", () => {
  it("traduce los eventos de ciclo de vida con sus dos formas de payload", () => {
    expect(
      toEvent("pane_closed", { pane_id: "w2:p2", type: "pane_closed", workspace_id: "w2" }),
    ).toEqual({ type: "pane_closed", paneId: "w2:p2", workspaceId: "w2" });
    expect(toEvent("pane_exited", { pane_id: "w2:p2", workspace_id: "w2" })).toEqual({
      type: "pane_exited",
      paneId: "w2:p2",
      workspaceId: "w2",
    });
    expect(toEvent("workspace_closed", { workspace_id: "w2", workspace: {} })).toEqual({
      type: "workspace_closed",
      workspaceId: "w2",
    });
    expect(toEvent("worktree_created", { workspace: { workspace_id: "w3" } })).toEqual({
      type: "worktree_created",
      workspaceId: "w3",
    });
  });

  it("ignora los eventos que el adapter no expone", () => {
    expect(toEvent("workspace_metadata_updated", { workspace_id: "w1" })).toBeUndefined();
  });

  it("expande el ~ con que herdr colapsa el home", () => {
    expect(normalizePath("~/.herdr/no-existe")).toBe(`${homedir()}/.herdr/no-existe`);
  });

  it("descarta tokens nulos y conserva la identidad de sesión del agente", () => {
    const agent = toAgent({
      name: "t1-refine-1",
      agent: "claude",
      pane_id: "w2:p2",
      workspace_id: "w2",
      agent_status: "done",
      tokens: { task: "t1", phase: null },
      agent_session: { agent: "claude", kind: "id", source: "herdr:claude", value: "uuid" },
    });
    expect(agent.tokens).toEqual({ task: "t1" });
    expect(agent.session).toEqual({ kind: "id", source: "herdr:claude", value: "uuid" });
    expect(agent.title).toBeUndefined();
  });

  it("el snapshot descarta los agentes sin nombre que el usuario abrió a mano", () => {
    const agent = { agent: "claude", pane_id: "w1:p1", workspace_id: "w1", agent_status: "idle" };
    const snapshot = toSnapshot(
      snapshotWire.parse({
        snapshot: {
          version: "0.9.5",
          protocol: 22,
          workspaces: [],
          panes: [],
          agents: [agent, { ...agent, name: null }, { ...agent, name: "t1-refine-1" }],
        },
      }),
    );
    expect(snapshot.agents.map((a) => a.name)).toEqual(["t1-refine-1"]);
  });

  it("el snapshot tolera agentes que herdr aún no identificó (sin `agent`)", () => {
    const named = {
      name: "t1-refine-1",
      agent: "claude",
      pane_id: "w1:p1",
      workspace_id: "w1",
      agent_status: "idle",
    };
    const snapshot = toSnapshot(
      snapshotWire.parse({
        snapshot: {
          version: "0.9.5",
          protocol: 22,
          workspaces: [],
          panes: [],
          agents: [{ ...named, name: "t2-refine-1", agent: undefined }, named],
        },
      }),
    );
    expect(snapshot.agents.map((a) => a.name)).toEqual(["t1-refine-1"]);
  });
});
