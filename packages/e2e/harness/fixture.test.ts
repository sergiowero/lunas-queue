import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFixture, mergeIntoMain } from "./fixture.ts";
import { git } from "./git.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lunasq-fixture-"));
  dirs.push(root);
  return createFixture(root);
}

describe("fixture del piloto", () => {
  it("deja main en el origin con los hooks por fase y una suite que corre", () => {
    const { origin, repo } = fixture();
    expect(git(origin, "ls-tree", "-r", "--name-only", "main").split("\n")).toEqual(
      expect.arrayContaining([
        "test.sh",
        "lunasq/hooks/config",
        "lunasq/hooks/before_verification/10-prepare.sh",
      ]),
    );
    expect(git(repo, "rev-parse", "origin/main")).toBe(git(origin, "rev-parse", "main"));
    expect(git(repo, "ls-files", "-s", "test.sh")).toMatch(/^100755/);
  });

  it("mergeIntoMain avanza main del origin hasta la rama de la tarea", () => {
    const fx = fixture();
    git(fx.repo, "checkout", "-b", "lunasq/t1");
    git(fx.repo, "commit", "--allow-empty", "-m", "feat: t1");
    git(fx.repo, "push", "--quiet", "origin", "lunasq/t1");
    mergeIntoMain(fx, "lunasq/t1");
    expect(git(fx.origin, "rev-parse", "main")).toBe(git(fx.repo, "rev-parse", "HEAD"));
  });

  it("mergeIntoMain rechaza una rama que no descende de main", () => {
    const fx = fixture();
    git(fx.repo, "checkout", "-b", "lunasq/t1");
    git(fx.repo, "commit", "--allow-empty", "-m", "feat: t1");
    git(fx.repo, "push", "--quiet", "origin", "lunasq/t1");
    git(fx.repo, "checkout", "main");
    git(fx.repo, "commit", "--allow-empty", "-m", "feat: otro");
    git(fx.repo, "push", "--quiet", "origin", "main");
    expect(() => mergeIntoMain(fx, "lunasq/t1")).toThrow("no es mergeable");
  });
});
