import { describe, expect, it } from "vitest";
import { AgentProviderRegistry, agentProviders, packageName } from "./index.ts";

describe("@lunasq/adapters", () => {
  it("exports its package name", () => {
    expect(packageName).toBe("@lunasq/adapters");
  });

  it("builds CLI-specific arguments and orders the fallback with the primary first", () => {
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

  it("rejects flags that compete with fixed per-provider options", () => {
    expect(() =>
      agentProviders.get("copilot").args(
        { kind: "copilot", args: ["--session-id=x"] },
        {
          mcpConfigPath: "/mcp",
          settingsPath: "/settings",
          sessionId: "id",
        },
      ),
    ).toThrow(/LunasQ sets it/);
    expect(() =>
      agentProviders.get("claude").args(
        { kind: "claude", effort: "high", args: ["--effort=low"] },
        {
          mcpConfigPath: "/mcp",
          settingsPath: "/settings",
          sessionId: "id",
        },
      ),
    ).toThrow(/keep one/);
  });

  it("launches Copilot in autopilot even if the profile brings no model, effort or args", () => {
    const args = agentProviders
      .get("copilot")
      .args(
        { kind: "copilot", args: [] },
        { mcpConfigPath: "/mcp", settingsPath: "/settings", sessionId: "id" },
      );
    expect(args.filter((arg) => arg === "--autopilot")).toEqual(["--autopilot"]);
  });

  it("reserves --autopilot, --mode and --plan for Copilot", () => {
    const context = { mcpConfigPath: "/mcp", settingsPath: "/settings", sessionId: "id" };
    for (const args of [["--autopilot"], ["--mode", "autopilot"], ["--mode=plan"], ["--plan"]]) {
      expect(() => agentProviders.get("copilot").args({ kind: "copilot", args }, context)).toThrow(
        /LunasQ sets it/,
      );
    }
  });

  it("rejects the -- terminator in Copilot args so it does not cancel the fixed flags", () => {
    const context = { mcpConfigPath: "/mcp", settingsPath: "/settings", sessionId: "id" };
    expect(() =>
      agentProviders.get("copilot").args({ kind: "copilot", args: ["--", "x"] }, context),
    ).toThrow(/cannot carry --/);
  });

  it("does not pass autopilot flags to Claude nor reserve Copilot's", () => {
    const context = { mcpConfigPath: "/mcp", settingsPath: "/settings", sessionId: "id" };
    // Contrast: the same empty profile carries --autopilot in Copilot and not in Claude.
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
    // --mode and --plan are only reserved for Copilot: Claude lets them through as is.
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

  it("rejects duplicate providers in the registry", () => {
    const claude = agentProviders.get("claude");
    expect(() => new AgentProviderRegistry([claude, claude])).toThrow(/duplicate/);
  });

  it("expresses the reviewer evidence mechanism each provider uses", () => {
    expect(agentProviders.get("claude").capabilities.reviewerExecution).toBe("native-hooks");
    expect(agentProviders.get("copilot").capabilities.reviewerExecution).toBe("lunasq-runner");
  });
});
