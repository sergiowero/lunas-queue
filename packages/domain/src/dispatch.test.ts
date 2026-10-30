import { describe, expect, it } from "vitest";
import {
  AGENT_NAME_PATTERN,
  agentArgs,
  agentName,
  DispatchRuleError,
  isAgentName,
  nudgePrompt,
  phasePrompt,
  resolveSession,
  runEnv,
} from "./dispatch.ts";

const TASK = "0f3c9a2e-7b41-4d2a-9e0c-5a6b7c8d9e10";

describe("agentName", () => {
  it("es determinístico y cumple el patrón de nombres de herdr", () => {
    const name = agentName(TASK, "implement", 3);
    expect(name).toBe("t0f3c9a2e7b41-implement-3");
    expect(agentName(TASK, "implement", 3)).toBe(name);
    expect(name).toMatch(AGENT_NAME_PATTERN);
  });

  it("cabe en 32 caracteres con la fase más larga y ordinales grandes", () => {
    expect(agentName(TASK, "implement", 9999).length).toBeLessThanOrEqual(32);
  });

  it("distingue fase y ordinal", () => {
    expect(agentName(TASK, "refine", 1)).not.toBe(agentName(TASK, "verify", 1));
    expect(agentName(TASK, "refine", 1)).not.toBe(agentName(TASK, "refine", 2));
  });

  it("rechaza ordinales no positivos y nombres que no caben", () => {
    expect(() => agentName(TASK, "refine", 0)).toThrow(DispatchRuleError);
    expect(() => agentName(TASK, "implement", 10 ** 12)).toThrow(DispatchRuleError);
    expect(() => agentName("x!", "refine", 1)).toThrow(DispatchRuleError);
  });
});

describe("runEnv", () => {
  it("lleva token, tarea, Run y fase con los nombres de tech-stack", () => {
    expect(runEnv({ runToken: "tok", taskId: TASK, runId: "run-1", phase: "verify" })).toEqual({
      LUNASQ_RUN_TOKEN: "tok",
      LUNASQ_TASK_ID: TASK,
      LUNASQ_RUN_ID: "run-1",
      LUNASQ_PHASE: "verify",
    });
  });
});

describe("agentArgs", () => {
  const base = {
    mcpConfigPath: "/cfg/mcp.json",
    settingsPath: "/cfg/settings.json",
    sessionId: "sess-1",
  };

  it("antepone el modelo, conserva los args del perfil y agrega MCP estricto, hooks y session id", () => {
    expect(
      agentArgs({ kind: "claude", model: "opus", args: ["--permission-mode", "auto"] }, base),
    ).toEqual([
      "--model",
      "opus",
      "--permission-mode",
      "auto",
      "--mcp-config",
      "/cfg/mcp.json",
      "--strict-mcp-config",
      "--settings",
      "/cfg/settings.json",
      "--session-id",
      "sess-1",
    ]);
  });

  it("sin modelo no agrega --model", () => {
    expect(agentArgs({ kind: "claude", args: [] }, base)).toEqual([
      "--mcp-config",
      "/cfg/mcp.json",
      "--strict-mcp-config",
      "--settings",
      "/cfg/settings.json",
      "--session-id",
      "sess-1",
    ]);
  });

  it("rechaza un perfil que ya trae los flags que fija el dispatcher", () => {
    for (const flag of [
      "--mcp-config",
      "--mcp-config=/x",
      "--strict-mcp-config",
      "--session-id",
      "--settings",
      "--settings=/x",
      "--model",
    ]) {
      expect(() => agentArgs({ kind: "claude", model: "opus", args: [flag, "x"] }, base)).toThrow(
        DispatchRuleError,
      );
    }
    // --model en los args sin `model` en el perfil es válido: no se duplica.
    expect(agentArgs({ kind: "claude", args: ["--model", "haiku"] }, base)).toContain("haiku");
  });
});

describe("phasePrompt", () => {
  it("invoca la skill de la fase con el task id y manda al contexto por MCP", () => {
    const prompt = phasePrompt("refine", TASK);
    expect(prompt).toContain("refine-task");
    expect(prompt).toContain(TASK);
    expect(prompt).toContain("get_task_context");
    expect(phasePrompt("implement", TASK)).toContain("implement-task");
    expect(phasePrompt("verify", TASK)).toContain("verify-task");
  });

  it("es una sola línea: herdr la manda como un solo prompt", () => {
    expect(phasePrompt("verify", TASK)).not.toContain("\n");
  });
});

describe("isAgentName", () => {
  it("reconoce los nombres que arma agentName y nada más", () => {
    expect(isAgentName(agentName(TASK, "verify", 3))).toBe(true);
    expect(isAgentName("t0f3c9a2e7b41-deliver-1")).toBe(false);
    expect(isAgentName("t0f3c9a2e7b41-refine-0")).toBe(false);
    expect(isAgentName("mi-agente")).toBe(false);
    expect(isAgentName(`x${agentName(TASK, "refine", 1)}`)).toBe(false);
  });
});

describe("nudgePrompt", () => {
  it("recuerda la fase abierta y las tools de salida, en una sola línea", () => {
    const prompt = nudgePrompt("implement", TASK);
    expect(prompt).toContain(TASK);
    expect(prompt).toContain("implement-task");
    expect(prompt).toContain("report_failure");
    expect(prompt).toContain("ask_human");
    expect(prompt).not.toContain("\n");
  });
});

describe("resolveSession", () => {
  const name = "t0f3c9a2e7b41-refine-1";

  it("prefiere el session id nativo", () => {
    expect(resolveSession({ nativeId: "n-1", herdr: { value: "h-1" }, agentName: name })).toEqual({
      value: "n-1",
      source: "native",
    });
  });

  it("si no hay nativo usa el que reporta herdr", () => {
    expect(resolveSession({ herdr: { value: "h-1" }, agentName: name })).toEqual({
      value: "h-1",
      source: "herdr",
    });
  });

  it("como respaldo usa el nombre determinístico del agente", () => {
    expect(resolveSession({ nativeId: null, agentName: name })).toEqual({
      value: name,
      source: "name",
    });
  });
});
