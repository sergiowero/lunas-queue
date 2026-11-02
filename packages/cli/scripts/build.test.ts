import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPackage } from "./build.ts";

const exec = promisify(execFile);
let outdir: string;
let home: string;

beforeAll(async () => {
  // Inside packages/cli: the bundle resolves better-sqlite3 from its node_modules. The name is
  // unique: two runs in the same checkout do not share a directory (.gitignore covers it).
  outdir = await buildPackage(
    join(import.meta.dirname, "..", `dist-test-${process.pid}-${randomUUID().slice(0, 8)}`),
  );
  home = mkdtempSync(join(tmpdir(), "lunasq-bundle-"));
}, 120_000);

afterAll(() => {
  rmSync(outdir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

async function lunasq(...args: string[]) {
  const env = { ...process.env, LUNASQ_HOME: join(home, "l"), CLAUDE_CONFIG_DIR: join(home, "c") };
  return exec(process.execPath, [join(outdir, "bin", "lunasq.js"), ...args], { env }).catch(
    (err: { stdout: string; stderr: string; code: number }) => err,
  );
}

describe("npm package", () => {
  it("declares the lunasq binary and only better-sqlite3 as a dependency", () => {
    const pkg = JSON.parse(readFileSync(join(outdir, "package.json"), "utf8"));
    expect(pkg).toMatchObject({ name: "lunasq", bin: { lunasq: "bin/lunasq.js" } });
    expect(Object.keys(pkg.dependencies)).toEqual(["better-sqlite3"]);
  });

  it("includes the front end build next to the binary", () => {
    expect(existsSync(join(outdir, "web", "index.html"))).toBe(true);
  });

  it("the bundle runs, applies the migrations and finds the assets next to itself", async () => {
    expect((await lunasq("--version")).stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    const { stdout } = await lunasq("doctor", "--json");
    const results = JSON.parse(stdout) as { id: string; status: string }[];
    expect(results.find((r) => r.id === "sqlite")?.status).toBe("ok");
    expect(results.map((r) => r.id)).toEqual(
      expect.arrayContaining([
        "skill:implement-task",
        "skill:refine-task",
        "skill:verify-task",
        "agents",
      ]),
    );
  });
});
