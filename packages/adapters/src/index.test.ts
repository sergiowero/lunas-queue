import { describe, expect, it } from "vitest";
import { AgentProviderRegistry, agentProviders, packageName } from "./index.ts";

describe("@lunasq/adapters", () => {
  it("exporta su nombre de paquete", () => {
    expect(packageName).toBe("@lunasq/adapters");
  });

  it("construye argumentos específicos de cada CLI y ordena el fallback con el primario primero", () => {
    const context = {
      mcpConfigPath: "/cfg/mcp.json",
      settingsPath: "/cfg/settings.json",
      sessionId: "sess-1",
    };
    expect(
      agentProviders
        .get("claude")
        .args(
          { kind: "claude", model: "sonnet", effort: "high", args: ["--permission-mode", "auto"] },
          context,
        ),
    ).toEqual([
      "--model",
      "sonnet",
      "--effort",
      "high",
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
    expect(
      agentProviders.get("copilot").args(
        {
          kind: "copilot",
          model: "gpt-5",
          effort: "xhigh",
          args: ["--disable-client-telemetry"],
        },
        context,
      ),
    ).toEqual([
      "--model",
      "gpt-5",
      "--reasoning-effort",
      "xhigh",
      "--disable-client-telemetry",
      "--allow-all-tools",
      "--session-id",
      "sess-1",
      "--additional-mcp-config",
      "@/cfg/mcp.json",
    ]);
    expect(agentProviders.fallbackOrder("copilot").map((provider) => provider.kind)).toEqual([
      "copilot",
      "claude",
    ]);
  });

  it("rechaza flags que compiten con opciones fijas por proveedor", () => {
    expect(() =>
      agentProviders.get("copilot").args(
        { kind: "copilot", args: ["--session-id=x"] },
        {
          mcpConfigPath: "/mcp",
          settingsPath: "/settings",
          sessionId: "id",
        },
      ),
    ).toThrow(/lo fija LunasQ/);
    expect(() =>
      agentProviders.get("claude").args(
        { kind: "claude", effort: "high", args: ["--effort=low"] },
        {
          mcpConfigPath: "/mcp",
          settingsPath: "/settings",
          sessionId: "id",
        },
      ),
    ).toThrow(/deja uno/);
  });

  it("rechaza providers duplicados en el registry", () => {
    const claude = agentProviders.get("claude");
    expect(() => new AgentProviderRegistry([claude, claude])).toThrow(/duplicados/);
  });

  it("expresa el mecanismo de evidencia de revisores que usa cada proveedor", () => {
    expect(agentProviders.get("claude").capabilities.reviewerExecution).toBe("native-hooks");
    expect(agentProviders.get("copilot").capabilities.reviewerExecution).toBe("lunasq-runner");
  });
});
