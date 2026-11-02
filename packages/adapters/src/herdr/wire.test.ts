import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { normalizePath, snapshotWire, toAgent, toEvent, toSnapshot } from "./wire.ts";

describe("herdr protocol translation", () => {
  it("translates the lifecycle events with their two payload shapes", () => {
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

  it("ignores the events the adapter does not expose", () => {
    expect(toEvent("workspace_metadata_updated", { workspace_id: "w1" })).toBeUndefined();
  });

  it("expands the ~ that herdr collapses the home into", () => {
    expect(normalizePath("~/.herdr/no-existe")).toBe(`${homedir()}/.herdr/no-existe`);
  });

  it("drops null tokens and keeps the agent's session identity", () => {
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

  it("the snapshot drops the unnamed agents the user opened by hand", () => {
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

  it("the snapshot tolerates agents herdr has not identified yet (without `agent`)", () => {
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
