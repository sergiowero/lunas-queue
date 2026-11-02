// Where each file that LunasQ installs or reads lives. `LUNASQ_HOME`, `CLAUDE_CONFIG_DIR` (the same
// one Claude Code respects) and `HERDR_CONFIG_PATH` (herdr's) change the default paths.
import { homedir } from "node:os";
import { join } from "node:path";

export interface Paths {
  /** LunasQ's own directory: configuration, database and stable files for Claude Code. */
  home: string;
  config: string;
  db: string;
  /** Stable MCP file (ADR 0002). */
  mcpConfig: string;
  /** Settings with the subagent hooks (ADR uw-19-revisores). */
  hookSettings: string;
  /** Asset destinations that LunasQ installed: only those are overwritten or deleted. */
  manifest: string;
  claudeHome: string;
  /** Claude Code user skills; each phase skill goes in its own folder. */
  skills: string;
  /** Reviewer subagents (docs/design.md §Verification with subagents). */
  agents: string;
  copilotHome: string;
  copilotMcpConfig: string;
  copilotSkills: string;
  copilotAgents: string;
  herdrConfig: string;
}

export function resolvePaths(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): Paths {
  const lunasqHome = env.LUNASQ_HOME ?? join(home, ".lunasq");
  const claudeHome = env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
  const copilotHome = env.COPILOT_HOME ?? join(home, ".copilot");
  return {
    home: lunasqHome,
    config: join(lunasqHome, "config.json"),
    db: join(lunasqHome, "lunasq.db"),
    mcpConfig: join(lunasqHome, "mcp.json"),
    hookSettings: join(lunasqHome, "claude-settings.json"),
    manifest: join(lunasqHome, "installed-assets.json"),
    claudeHome,
    skills: join(claudeHome, "skills"),
    agents: join(claudeHome, "agents", "lunasq"),
    copilotHome,
    copilotMcpConfig: join(copilotHome, "mcp-config.json"),
    copilotSkills: join(copilotHome, "skills"),
    copilotAgents: join(copilotHome, "agents", "lunasq"),
    herdrConfig: env.HERDR_CONFIG_PATH ?? join(home, ".config", "herdr", "config.toml"),
  };
}
