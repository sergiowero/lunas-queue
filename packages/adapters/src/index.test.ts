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
      "--autopilot",
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

  it("lanza Copilot en autopilot aunque el perfil no traiga model, effort ni args", () => {
    const args = agentProviders
      .get("copilot")
      .args(
        { kind: "copilot", args: [] },
        { mcpConfigPath: "/mcp", settingsPath: "/settings", sessionId: "id" },
      );
    expect(args.filter((arg) => arg === "--autopilot")).toEqual(["--autopilot"]);
  });

  it("reserva --autopilot, --mode y --plan para Copilot", () => {
    const context = { mcpConfigPath: "/mcp", settingsPath: "/settings", sessionId: "id" };
    for (const args of [["--autopilot"], ["--mode", "autopilot"], ["--mode=plan"], ["--plan"]]) {
      expect(() => agentProviders.get("copilot").args({ kind: "copilot", args }, context)).toThrow(
        /lo fija LunasQ/,
      );
    }
  });

  it("rechaza el terminador -- en los args de Copilot para que no anule los flags fijos", () => {
    const context = { mcpConfigPath: "/mcp", settingsPath: "/settings", sessionId: "id" };
    expect(() =>
      agentProviders.get("copilot").args({ kind: "copilot", args: ["--", "x"] }, context),
    ).toThrow(/no puede traer --/);
  });

  it("no pasa flags de autopilot a Claude ni reserva los de Copilot", () => {
    const context = { mcpConfigPath: "/mcp", settingsPath: "/settings", sessionId: "id" };
    // Contraste: el mismo perfil vacío lleva --autopilot en Copilot y no en Claude.
    expect(agentProviders.get("copilot").args({ kind: "copilot", args: [] }, context)).toContain(
      "--autopilot",
    );
    expect(agentProviders.get("claude").args({ kind: "claude", args: [] }, context)).toEqual([
      "--mcp-config",
      "/mcp",
      "--strict-mcp-config",
      "--settings",
      "/settings",
      "--session-id",
      "id",
    ]);
    // --mode y --plan solo están reservados para Copilot: Claude los deja pasar tal cual.
    expect(
      agentProviders
        .get("claude")
        .args({ kind: "claude", args: ["--mode", "x", "--plan"] }, context),
    ).toEqual([
      "--mode",
      "x",
      "--plan",
      "--mcp-config",
      "/mcp",
      "--strict-mcp-config",
      "--settings",
      "/settings",
      "--session-id",
      "id",
    ]);
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
