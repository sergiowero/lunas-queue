import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assetTargets, drift, findAssetsRoot, mirror, repoAssetsRoot } from "./assets.ts";
import { resolvePaths } from "./paths.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), "lunasq-assets-"));
  dirs.push(dir);
  return dir;
}

describe("assetTargets", () => {
  it("installs skills and reviewers for Claude and Copilot", async () => {
    const targets = await assetTargets(repoAssetsRoot(), resolvePaths({}, "/h"));
    expect(targets.map((t) => [t.kind, t.name, t.dest])).toEqual([
      ["skill", "implement-task", "/h/.claude/skills/implement-task"],
      ["skill", "refine-task", "/h/.claude/skills/refine-task"],
      ["skill", "verify-task", "/h/.claude/skills/verify-task"],
      ["copilot-skill", "implement-task", "/h/.copilot/skills/implement-task"],
      ["copilot-skill", "refine-task", "/h/.copilot/skills/refine-task"],
      ["copilot-skill", "verify-task", "/h/.copilot/skills/verify-task"],
      ["agents", "lunasq", "/h/.claude/agents/lunasq"],
      ["copilot-agents", "lunasq", "/h/.copilot/agents/lunasq"],
    ]);
  });

  it("in the repo it finds the root assets", () => {
    expect(findAssetsRoot()).toBe(repoAssetsRoot());
  });
});

describe("mirror", () => {
  it("copies, updates and deletes the leftovers; repeating it changes nothing", async () => {
    const src = tmp();
    const dest = join(tmp(), "out");
    mkdirSync(join(src, "nested"));
    writeFileSync(join(src, "a.md"), "a");
    writeFileSync(join(src, "nested", "b.md"), "b");

    expect(await mirror(src, dest)).toEqual(["a.md", join("nested", "b.md")]);
    expect(readFileSync(join(dest, "nested", "b.md"), "utf8")).toBe("b");
    expect(await mirror(src, dest)).toEqual([]);

    writeFileSync(join(src, "a.md"), "a2");
    writeFileSync(join(dest, "viejo.md"), "x");
    expect(await drift(src, dest)).toEqual(["a.md", "viejo.md"]);
    await mirror(src, dest);
    expect(readFileSync(join(dest, "a.md"), "utf8")).toBe("a2");
    expect(existsSync(join(dest, "viejo.md"))).toBe(false);
  });
});
