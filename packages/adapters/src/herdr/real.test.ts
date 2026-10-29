import { describe, expect, it } from "vitest";
import type { ExecFn } from "./cli.ts";
import { RealHerdr } from "./real.ts";

// Ramas del adapter real que la suite contra herdr no provoca de forma fiable (respuestas de
// error concretas, carreras); se prueban con un exec simulado que responde por subcomando.
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
    if (!respond) throw new Error(`sin respuesta para ${key}`);
    return respond();
  };
  return { exec, calls };
}

describe("RealHerdr con exec simulado", () => {
  it("startAgent con agent_not_ready devuelve el agente bloqueado como arrancado", async () => {
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

  it("startAgent con agent_name_taken (carrera) devuelve el existente sin arrancar", async () => {
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

  it("startAgent propaga otros errores", async () => {
    const { exec } = scripted({
      "agent get": () => error("agent_not_found"),
      "agent start": () => error("pane_not_found"),
    });
    await expect(
      new RealHerdr({ exec }).startAgent({ name: "x", kind: "claude", paneId: "w9:p1" }),
    ).rejects.toMatchObject({ code: "pane_not_found" });
  });

  it("los comandos que esperan dan al CLI margen sobre el timeout de herdr", async () => {
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
