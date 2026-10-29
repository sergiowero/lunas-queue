// La suite de contrato contra git real corre en `pnpm test`: solo usa repos temporales.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { gitContract, type RepoFiles } from "./contract.ts";
import { isGitError } from "./errors.ts";
import { RealGit } from "./real.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "lunasq-git-")));
let repos = 0;

const IDENTITY = ["-c", "user.name=LunasQ Test", "-c", "user.email=test@lunasq.local"];
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", [...IDENTITY, ...args], { cwd, stdio: "pipe" }).toString("utf8");

function writeTree(dir: string, files: RepoFiles) {
  for (const [path, file] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, file.content);
    chmodSync(full, file.executable ? 0o755 : 0o644);
  }
}

/** Un remoto bare con `files` en main, un clon de trabajo para empujar y el checkout a probar. */
function newRepo(files: RepoFiles) {
  const base = join(root, `r${++repos}`);
  const origin = join(base, "origin.git");
  const pusher = join(base, "pusher");
  const checkout = join(base, "checkout");
  mkdirSync(base);
  execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", pusher]);
  git(pusher, "remote", "add", "origin", origin);
  commitTree(pusher, files);
  execFileSync("git", ["clone", "--quiet", origin, checkout]);
  // El commit de los hooks usa la identidad del repo, como en un checkout real configurado.
  git(checkout, "config", "user.name", "LunasQ Test");
  git(checkout, "config", "user.email", "test@lunasq.local");
  return checkout;
}

function commitTree(pusher: string, files: RepoFiles) {
  git(pusher, "rm", "-r", "--quiet", "--ignore-unmatch", ".");
  writeTree(pusher, files);
  git(pusher, "add", "--all");
  git(pusher, "commit", "--quiet", "--allow-empty", "-m", "tree");
  git(pusher, "push", "--quiet", "origin", "main");
}

afterAll(() => rmSync(root, { recursive: true, force: true }));

gitContract("git real", async () => ({
  adapter: new RealGit(),
  newRepo: async (files) => newRepo(files),
  pushToRemote: async (cwd, files) => commitTree(join(dirname(cwd), "pusher"), files),
  writeWorkingFile: async (cwd, path, content) => writeTree(cwd, { [path]: { content } }),
  headMessage: async (cwd) => git(cwd, "log", "-1", "--format=%B"),
  cleanup: async () => {},
}));

describe("RealGit", () => {
  const adapter = new RealGit();

  it("listFiles no cuenta symlinks: podrían apuntar al worktree de la tarea", async () => {
    const cwd = newRepo({
      "lunasq/hooks/after_merge/10-ok": { content: "#!/bin/sh\n", executable: true },
    });
    const pusher = join(dirname(cwd), "pusher");
    symlinkSync("/tmp/evil", join(pusher, "lunasq/hooks/after_merge/20-link"));
    git(pusher, "add", "--all");
    git(pusher, "commit", "--quiet", "-m", "link");
    git(pusher, "push", "--quiet", "origin", "main");
    await adapter.fetch({ cwd, remote: "origin", branch: "main" });
    const commit = await adapter.resolveCommit({ cwd, ref: "origin/main" });

    const files = await adapter.listFiles({ cwd, commit, dir: "lunasq/hooks/after_merge" });
    expect(files).toEqual([{ name: "10-ok", executable: true }]);
    expect(
      await adapter.readFile({ cwd, commit, path: "lunasq/hooks/after_merge/20-link" }),
    ).toBeUndefined();
  });

  it("un cwd inexistente es git_unavailable", async () => {
    await expect(adapter.isDirty(join(root, "no-existe"))).rejects.toSatisfy((err) =>
      isGitError(err, "git_unavailable"),
    );
  });

  it("un ref con forma de opción no se interpreta como opción", async () => {
    const cwd = newRepo({ "a.txt": { content: "a" } });
    await expect(adapter.resolveCommit({ cwd, ref: "--all" })).rejects.toSatisfy((err) =>
      isGitError(err, "ref_not_found"),
    );
  });
});
