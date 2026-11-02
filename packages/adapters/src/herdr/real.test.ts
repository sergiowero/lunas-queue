import { describe, expect, it } from "vitest";
import type { ExecFn } from "./cli.ts";
import { RealHerdr } from "./real.ts";

// Branches of the real adapter that the suite against herdr does not reliably cause (specific
// error responses, races); they are tested with a simulated exec that answers by subcommand.
const agentJson = (status: string) =>
  JSON.stringify({
    id: "cli:agent:get",
    result: {
      type: "agent_info",
      agent: {
        name: "t1-refine-1",
        agent: "claude",
        pane_id: "w2:p2",
        workspace_id: "w2",
        agent_status: status,
      },
    },
  });
const startedAgentWithoutKindJson = JSON.stringify({
  id: "cli:agent:start",
  result: {
    type: "agent_info",
    agent: {
      name: "t1-refine-1",
      pane_id: "w2:p2",
      workspace_id: "w2",
      agent_status: "idle",
    },
  },
});
const error = (code: string) => ({
  stdout: "",
  stderr: JSON.stringify({ error: { code, message: code } }),
  exitCode: 1,
});

function scripted(
  responses: Record<string, () => { stdout: string; stderr: string; exitCode: number }>,
) {
  const calls: { args: string[]; timeoutMs: number }[] = [];
  const exec: ExecFn = async (_file, args, timeoutMs) => {
    calls.push({ args, timeoutMs });
    const key = args.slice(0, 2).join(" ");
    const respond = responses[key];
    if (!respond) throw new Error(`no response for ${key}`);
    return respond();
  };
  return { exec, calls };
}

describe("RealHerdr with a simulated exec", () => {
  it("startAgent keeps the requested kind if herdr omits it in the initial response", async () => {
    const { exec } = scripted({
      "agent get": () => error("agent_not_found"),
      "agent start": () => ({ stdout: startedAgentWithoutKindJson, stderr: "", exitCode: 0 }),
    });

    const result = await new RealHerdr({ exec }).startAgent({
      name: "t1-refine-1",
      kind: "copilot",
      paneId: "w2:p2",
    });

    expect(result).toMatchObject({
      started: true,
      agent: { name: "t1-refine-1", kind: "copilot", status: "idle" },
    });
  });

  it("startAgent with agent_not_ready returns the blocked agent as started", async () => {
    let gets = 0;
    const { exec } = scripted({
      "agent get": () =>
        gets++ === 0
          ? error("agent_not_found")
          : { stdout: agentJson("blocked"), stderr: "", exitCode: 0 },
      "agent start": () => error("agent_not_ready"),
    });
    const res = await new RealHerdr({ exec }).startAgent({
      name: "t1-refine-1",
      kind: "claude",
      paneId: "w2:p2",
    });
    expect(res.started).toBe(true);
    expect(res.agent.status).toBe("blocked");
  });

  it("startAgent with agent_name_taken (race) returns the existing one without starting", async () => {
    let gets = 0;
    const { exec } = scripted({
      "agent get": () =>
        gets++ === 0
          ? error("agent_not_found")
          : { stdout: agentJson("idle"), stderr: "", exitCode: 0 },
      "agent start": () => error("agent_name_taken"),
    });
    const res = await new RealHerdr({ exec }).startAgent({
      name: "t1-refine-1",
      kind: "claude",
      paneId: "w2:p2",
    });
    expect(res.started).toBe(false);
  });

  it("startAgent propagates other errors", async () => {
    const { exec } = scripted({
      "agent get": () => error("agent_not_found"),
      "agent start": () => error("pane_not_found"),
    });
    await expect(
      new RealHerdr({ exec }).startAgent({ name: "x", kind: "claude", paneId: "w9:p1" }),
    ).rejects.toMatchObject({ code: "pane_not_found" });
  });

  it("focusAgent runs `agent focus` with the agent's name", async () => {
    const { exec, calls } = scripted({
      "agent focus": () => ({ stdout: agentJson("blocked"), stderr: "", exitCode: 0 }),
    });
    const agent = await new RealHerdr({ exec }).focusAgent("t1-refine-1");
    expect(calls[0]?.args).toEqual(["agent", "focus", "t1-refine-1"]);
    expect(agent).toMatchObject({ paneId: "w2:p2", status: "blocked" });
  });

  it("the commands that wait give the CLI margin over herdr's timeout", async () => {
    const { exec, calls } = scripted({
      "agent wait": () => ({ stdout: agentJson("done"), stderr: "", exitCode: 0 }),
      "api snapshot": () => error("server_unavailable"),
    });
    const herdr = new RealHerdr({ exec });
    await herdr.waitAgent({ name: "t1-refine-1", timeoutMs: 1_000 });
    await herdr.waitAgent({ name: "t1-refine-1" });
    await herdr.snapshot().catch(() => {});
    expect(calls.map((c) => c.timeoutMs)).toEqual([11_000, 0, 30_000]);
  });
});
