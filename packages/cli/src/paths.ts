// Dónde vive cada archivo que instala o lee LunasQ. `LUNASQ_HOME`, `CLAUDE_CONFIG_DIR` (el mismo
// que respeta Claude Code) y `HERDR_CONFIG_PATH` (el de herdr) cambian las rutas por defecto.
import { homedir } from "node:os";
import { join } from "node:path";

export interface Paths {
  /** Directorio propio de LunasQ: configuración, base y archivos estables para Claude Code. */
  home: string;
  config: string;
  db: string;
  /** Archivo MCP estable (ADR 0002). */
  mcpConfig: string;
  /** Settings con los hooks de subagentes (ADR uw-19-revisores). */
  hookSettings: string;
  /** Destinos de assets que instaló LunasQ: solo esos se sobrescriben o se borran. */
  manifest: string;
  claudeHome: string;
  /** Skills de usuario de Claude Code; cada skill de fase va en su carpeta. */
  skills: string;
  /** Subagentes revisores (docs/design.md §Verificación con subagentes). */
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
