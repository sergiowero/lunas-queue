import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureMcpConfig, mcpConfig } from "./mcp-config.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), "lunasq-mcp-"));
  dirs.push(dir);
  return dir;
}

describe("mcpConfig", () => {
  it("apunta al LunasQ MCP y manda el token por expansión de entorno, nunca literal", () => {
    expect(mcpConfig("http://127.0.0.1:4518/mcp")).toEqual({
      mcpServers: {
        lunasq: {
          type: "http",
          url: "http://127.0.0.1:4518/mcp",
          headers: { "X-LunasQ-Run-Token": `\${LUNASQ_RUN_TOKEN}` },
        },
      },
    });
  });
});

describe("ensureMcpConfig", () => {
  it("crea el archivo y sus carpetas; repetirlo no lo reescribe", async () => {
    const path = join(tmp(), "nested", "mcp.json");
    expect(await ensureMcpConfig(path, "http://localhost:1/mcp")).toEqual({ written: true });
    const mtime = statSync(path).mtimeMs;
    expect(await ensureMcpConfig(path, "http://localhost:1/mcp")).toEqual({ written: false });
    expect(statSync(path).mtimeMs).toBe(mtime);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(mcpConfig("http://localhost:1/mcp"));
  });

  it("lo reescribe si cambió la URL", async () => {
    const path = join(tmp(), "mcp.json");
    await ensureMcpConfig(path, "http://localhost:1/mcp");
    expect(await ensureMcpConfig(path, "http://localhost:2/mcp")).toEqual({ written: true });
    expect(readFileSync(path, "utf8")).toContain("localhost:2");
  });
});
