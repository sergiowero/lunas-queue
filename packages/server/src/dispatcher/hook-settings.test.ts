import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureHookSettings, hookSettings } from "./hook-settings.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), "lunasq-settings-"));
  dirs.push(dir);
  return dir;
}

const URL_ = "http://127.0.0.1:4518/hooks/subagent";

describe("hookSettings", () => {
  it("manda SubagentStart y SubagentStop al endpoint con el token expandido del entorno", () => {
    const hook = {
      type: "http",
      url: URL_,
      headers: { "X-LunasQ-Run-Token": "$LUNASQ_RUN_TOKEN" },
      allowedEnvVars: ["LUNASQ_RUN_TOKEN"],
      timeout: 10,
    };
    expect(hookSettings(URL_)).toEqual({
      hooks: {
        SubagentStart: [{ hooks: [hook] }],
        SubagentStop: [{ hooks: [hook] }],
      },
    });
  });

  it("nunca lleva un token literal", () => {
    expect(JSON.stringify(hookSettings(URL_))).not.toMatch(/[0-9a-f]{64}/);
  });
});

describe("ensureHookSettings", () => {
  it("crea el archivo y sus carpetas; repetirlo no lo reescribe", async () => {
    const path = join(tmp(), "nested", "settings.json");
    expect(await ensureHookSettings(path, URL_)).toEqual({ written: true });
    const mtime = statSync(path).mtimeMs;
    expect(await ensureHookSettings(path, URL_)).toEqual({ written: false });
    expect(statSync(path).mtimeMs).toBe(mtime);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(hookSettings(URL_));
  });

  it("lo reescribe si cambió la URL", async () => {
    const path = join(tmp(), "settings.json");
    await ensureHookSettings(path, URL_);
    expect(await ensureHookSettings(path, "http://127.0.0.1:9/hooks/subagent")).toEqual({
      written: true,
    });
    expect(readFileSync(path, "utf8")).toContain("127.0.0.1:9");
  });
});
