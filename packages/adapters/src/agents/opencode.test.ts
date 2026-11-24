import { describe, expect, it } from "vitest";
import { OPENCODE_CONFIG_ENV, opencodePhaseConfig, opencodeReviewerConfig } from "../index.ts";
import { AgentProviderError, agentProviders, validateProfileModel } from "./providers.ts";

const context = {
  mcpConfigPath: "/cfg/mcp.json",
  mcpUrl: "http://127.0.0.1:4321/mcp",
  settingsPath: "/cfg/settings.json",
  sessionId: "sess-1",
};

describe("OpenCode provider", () => {
  it("is registered after Codex, so it comes last in the fallback order", () => {
    expect(agentProviders.all().map((p) => p.kind)).toEqual([
      "claude",
      "copilot",
      "codex",
      "opencode",
    ]);
  });

  it("composes --model and the profile args, with no run token and no --auto", () => {
    const args = agentProviders
      .get("opencode")
      .args(
        { kind: "opencode", model: "anthropic/claude-sonnet-4", effort: "high", args: ["--mini"] },
        context,
      );
    expect(args).toEqual(["--model", "anthropic/claude-sonnet-4", "--mini"]);
    expect(args).not.toContain("--auto");
    expect(args.join(" ")).not.toMatch(/token/i);
  });

  it("starts without --model when the profile has no model", () => {
    expect(agentProviders.get("opencode").args({ kind: "opencode", args: [] }, context)).toEqual(
      [],
    );
  });

  it("reports that it does not provide usage and runs reviewers through LunasQ", () => {
    expect(agentProviders.get("opencode").capabilities).toEqual({
      usage: "unavailable",
      reviewerExecution: "lunasq-runner",
    });
  });

  it.each([
    ["--auto", "--auto"],
    ["--model=x", "--model=x"],
    ["-m", "-m"],
    ["--port", "--port"],
    ["--port=4096", "--port=4096"],
    ["--hostname", "--hostname"],
    ["--mdns", "--mdns"],
    ["--continue", "--continue"],
    ["-c", "-c"],
    ["--session", "--session"],
    ["-s", "-s"],
    ["--fork", "--fork"],
    ["--prompt", "--prompt"],
    ["--agent", "--agent"],
    ["--pure", "--pure"],
    ["--variant", "--variant"],
  ])("rejects the reserved flag %s in the profile args, naming it", (flag, named) => {
    const model = { kind: "opencode" as const, args: ["--mini", flag] };
    expect(() => validateProfileModel(model)).toThrow(AgentProviderError);
    expect(() => validateProfileModel(model)).toThrow(named);
  });

  it("rejects the option terminator, which would turn the fixed flags into positionals", () => {
    expect(() => validateProfileModel({ kind: "opencode", args: ["--", "x"] })).toThrow(/--/);
  });

  it("accepts a profile with only harmless args", () => {
    expect(() =>
      validateProfileModel({ kind: "opencode", model: "openai/gpt-5", args: ["--mini"] }),
    ).not.toThrow();
  });
});

describe("OpenCode inline config", () => {
  const phase = opencodePhaseConfig({
    mcpUrl: "http://127.0.0.1:4321/mcp",
    model: "anthropic/claude-sonnet-4",
    effort: "high",
  });

  it("travels in OPENCODE_CONFIG_CONTENT", () => {
    expect(OPENCODE_CONFIG_ENV).toBe("OPENCODE_CONFIG_CONTENT");
  });

  it("registers the remote LunasQ MCP server reading the token from the environment", () => {
    expect(phase.mcp).toEqual({
      lunasq: {
        type: "remote",
        url: "http://127.0.0.1:4321/mcp",
        enabled: true,
        headers: { "X-LunasQ-Run-Token": "{env:LUNASQ_RUN_TOKEN}" },
      },
    });
  });

  it("allows edits and commands without prompting and denies external directories", () => {
    expect(phase.permission).toMatchObject({
      edit: "allow",
      bash: "allow",
      external_directory: "deny",
    });
  });

  it("maps the effort to the model variant of the agent's own model", () => {
    expect(phase.agent).toEqual({
      build: { model: "anthropic/claude-sonnet-4", variant: "high" },
    });
  });

  it("sets no agent when the profile has no effort", () => {
    expect(opencodePhaseConfig({ mcpUrl: "http://x/mcp", model: "a/b" })).not.toHaveProperty(
      "agent",
    );
  });

  it("never contains a literal run token", () => {
    expect(JSON.stringify(phase)).not.toMatch(/tok_|secret/);
    expect(JSON.stringify(phase).match(/\{env:[A-Z_]+\}/g)).toEqual(["{env:LUNASQ_RUN_TOKEN}"]);
  });

  it("the reviewer config denies edits, external directories, the network and every other tool", () => {
    const reviewer = opencodeReviewerConfig();
    expect(reviewer).not.toHaveProperty("mcp");
    expect(reviewer.permission).toMatchObject({
      "*": "deny",
      edit: "deny",
      external_directory: "deny",
      webfetch: "deny",
      websearch: "deny",
      read: "allow",
    });
    const bash = (reviewer.permission as { bash: Record<string, string> }).bash;
    expect(bash["*"]).toBe("deny");
    expect(bash["git diff"]).toBe("allow");
    expect(bash["git diff *"]).toBe("allow");
    // No prefix globs: `git diff*` would also match `git difftool --extcmd=…`.
    expect(Object.keys(bash).filter((k) => k.startsWith("git") && k.endsWith("*"))).toEqual(
      expect.not.arrayContaining(["git diff*", "git grep*", "git log*"]),
    );
    for (const key of Object.keys(bash)) {
      if (bash[key] === "allow") expect(key).toMatch(/^[a-z-]+( [a-z-]+)?( \*)?$/);
    }
    // Commands that run other programs are not allowed at all.
    expect(Object.keys(bash)).not.toContain("rg *");
    expect(
      Object.keys(bash).some((k) => k.startsWith("git grep") || k.startsWith("git difftool")),
    ).toBe(false);
    // The denies come last, so they win over the allowlist.
    const keys = Object.keys(bash);
    const firstDeny = keys.findIndex((k, i) => i > 0 && bash[k] === "deny");
    expect(keys.slice(firstDeny).every((k) => bash[k] === "deny")).toBe(true);
    for (const flag of [
      "--output",
      "--ext-diff",
      "--textconv",
      "--open-files-in-pager",
      "--extcmd",
      "--pre",
      ">",
    ]) {
      expect(bash[`*${flag}*`]).toBe("deny");
    }
  });
});
