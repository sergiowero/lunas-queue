import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_PORT, parseConfig, readConfig, writeConfig } from "./config.ts";
import { resolvePaths } from "./paths.ts";
import { tomlString } from "./toml.ts";
import { compareVersions, parseVersion } from "./versions.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("resolvePaths", () => {
  it("usa ~/.lunasq y ~/.claude por defecto", () => {
    const p = resolvePaths({}, "/h");
    expect(p).toMatchObject({
      config: "/h/.lunasq/config.json",
      db: "/h/.lunasq/lunasq.db",
      mcpConfig: "/h/.lunasq/mcp.json",
      hookSettings: "/h/.lunasq/claude-settings.json",
      skills: "/h/.claude/skills",
      agents: "/h/.claude/agents/lunasq",
      herdrConfig: "/h/.config/herdr/config.toml",
    });
  });

  it("respeta LUNASQ_HOME, CLAUDE_CONFIG_DIR y HERDR_CONFIG_PATH", () => {
    const p = resolvePaths(
      { LUNASQ_HOME: "/l", CLAUDE_CONFIG_DIR: "/c", HERDR_CONFIG_PATH: "/x/herdr.toml" },
      "/h",
    );
    expect(p.herdrConfig).toBe("/x/herdr.toml");
    expect(p.config).toBe("/l/config.json");
    expect(p.agents).toBe("/c/agents/lunasq");
  });
});

describe("config", () => {
  it("completa defaults y rechaza valores inválidos", () => {
    expect(parseConfig({})).toEqual({ port: DEFAULT_PORT, telemetry: true });
    expect(() => parseConfig({ port: 0 })).toThrow(ConfigError);
    expect(() => parseConfig({ port: "80" })).toThrow(ConfigError);
    expect(() => parseConfig({ telemetry: "yes" })).toThrow(ConfigError);
    expect(() => parseConfig([])).toThrow(ConfigError);
  });

  it("lee lo que escribe; un archivo ausente es undefined y uno roto es ConfigError", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lunasq-config-"));
    dirs.push(dir);
    const path = join(dir, "sub", "config.json");
    expect(await readConfig(path)).toBeUndefined();
    await writeConfig(path, { port: 8000, telemetry: false });
    expect(await readConfig(path)).toEqual({ port: 8000, telemetry: false });
    writeFileSync(path, "{");
    await expect(readConfig(path)).rejects.toThrow(ConfigError);
  });
});

describe("tomlString", () => {
  it("lee una clave de una tabla, con puntos o comentarios", () => {
    expect(tomlString('[ui.toast]\ndelivery = "system" # nota\n', "ui.toast.delivery")).toBe(
      "system",
    );
    expect(tomlString("[ui]\ntoast.delivery = 'herdr'\n", "ui.toast.delivery")).toBe("herdr");
    expect(tomlString('ui.toast.delivery = "x"\n', "ui.toast.delivery")).toBe("x");
    expect(tomlString('[ui.toast]\n# delivery = "system"\n', "ui.toast.delivery")).toBeUndefined();
    expect(tomlString('[other]\ndelivery = "system"\n', "ui.toast.delivery")).toBeUndefined();
  });
});

describe("versions", () => {
  it("extrae y compara x.y.z", () => {
    expect(parseVersion("2.1.314 (Claude Code)")).toBe("2.1.314");
    expect(parseVersion("sin versión")).toBeUndefined();
    expect(compareVersions("0.9.5", "0.9.5")).toBe(0);
    expect(compareVersions("0.10.0", "0.9.5")).toBeGreaterThan(0);
    expect(compareVersions("2.1.311", "2.1.312")).toBeLessThan(0);
  });
});
