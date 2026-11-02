// The contract suite against real git runs in `pnpm test`: it only uses temporary repos.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
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

/** A bare remote with `files` on main, a working clone to push from and the checkout to test. */
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
  // The hooks commit uses the repo's identity, like in a really configured checkout.
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
  freePath: async () => join(root, `free${++repos}`),
  checkoutBranch: async (cwd, branch) => void git(cwd, "checkout", "--quiet", "-b", branch),
  remoteBranch: async (cwd, branch) => {
    const out = git(cwd, "ls-remote", "origin", `refs/heads/${branch}`).trim();
    return out === "" ? null : (out.split("\t")[0] ?? null);
  },
  headMessage: async (cwd) => git(cwd, "log", "-1", "--format=%B"),
  trackedFiles: async (cwd) => git(cwd, "ls-tree", "-r", "--name-only", "HEAD").split("\n"),
  cleanup: async () => {},
}));

describe("RealGit", () => {
  const adapter = new RealGit();

  it("listFiles does not count symlinks: they could point to the task's worktree", async () => {
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

  it("git replace from a worktree does not change what is read from the base", async () => {
    const cwd = newRepo({
      "lunasq/hooks/after_merge/10-ok": { content: "ok\n", executable: true },
    });
    const commit = await adapter.fetch({ cwd, remote: "origin", branch: "main" });
    const wt = join(dirname(cwd), "wt");
    git(cwd, "worktree", "add", "--quiet", "-b", "lunasq/t1", wt, "origin/main");
    const evil = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: wt, input: "evil\n" })
      .toString("utf8")
      .trim();
    git(
      wt,
      "replace",
      git(wt, "rev-parse", "origin/main:lunasq/hooks/after_merge/10-ok").trim(),
      evil,
    );

    const content = await adapter.readFile({ cwd, commit, path: "lunasq/hooks/after_merge/10-ok" });
    expect(content?.toString("utf8")).toBe("ok\n");
  });

  it("fetch returns the remote's sha even if another checkout moves the local ref", async () => {
    const cwd = newRepo({ "a.txt": { content: "a" } });
    const remoteSha = git(cwd, "rev-parse", "origin/main").trim();
    git(cwd, "commit", "--quiet", "--allow-empty", "-m", "local");
    const local = git(cwd, "rev-parse", "HEAD").trim();
    const fetched = await adapter.fetch({ cwd, remote: "origin", branch: "main" });
    git(cwd, "update-ref", "refs/remotes/origin/main", local);
    expect(fetched).toBe(remoteSha);
  });

  it("fetch retries when another fetch of the same ref wins the race", async () => {
    const cwd = newRepo({ "a.txt": { content: "a" } });
    const remoteSha = git(cwd, "rev-parse", "origin/main").trim();
    // git that fails the first `fetch` the way one that loses the race for the ref does.
    const dir = join(dirname(cwd), "bin");
    mkdirSync(dir);
    const flag = join(dir, "failed-once");
    const bin = join(dir, "git");
    writeFileSync(
      bin,
      `#!/bin/sh\ncase " $* " in *" fetch "*) [ ! -e '${flag}' ] && { : > '${flag}'; echo 'error: fetching ref refs/remotes/origin/main failed: incorrect old value provided' >&2; exit 1; };; esac\nexec git "$@"\n`,
      { mode: 0o755 },
    );
    const racy = new RealGit({ bin });
    expect(await racy.fetch({ cwd, remote: "origin", branch: "main" })).toBe(remoteSha);
    expect(existsSync(flag)).toBe(true);
  });

  it("fetch does not retry a failure that is not the race", async () => {
    const cwd = newRepo({ "a.txt": { content: "a" } });
    git(cwd, "remote", "set-url", "origin", join(dirname(cwd), "no-existe"));
    await expect(adapter.fetch({ cwd, remote: "origin", branch: "main" })).rejects.toThrow();
  });

  it("commitAll does not run the repo's git hooks and, if the commit fails, leaves the index clean", async () => {
    const cwd = newRepo({ "a.txt": { content: "a" } });
    const marker = join(dirname(cwd), "hook-ran");
    writeTree(cwd, {
      ".githooks/pre-commit": { content: `#!/bin/sh\ntouch ${marker}\nexit 1\n`, executable: true },
    });
    git(cwd, "config", "core.hooksPath", ".githooks");
    const sha = await adapter.commitAll({ cwd, message: "x", trailers: {} });
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(marker)).toBe(false);

    // A commit that fails (the branch ref is locked) leaves nothing staged.
    writeFileSync(join(cwd, ".git/refs/heads/main.lock"), "");
    writeTree(cwd, { "b.txt": { content: "b" } });
    await expect(adapter.commitAll({ cwd, message: "y", trailers: {} })).rejects.toSatisfy((err) =>
      isGitError(err, "git_failed"),
    );
    expect(git(cwd, "diff", "--cached", "--name-only")).toBe("");
  });

  it("a nonexistent cwd is git_unavailable", async () => {
    await expect(adapter.isDirty(join(root, "no-existe"))).rejects.toSatisfy((err) =>
      isGitError(err, "git_unavailable"),
    );
  });

  it("a ref shaped like an option is not interpreted as an option", async () => {
    const cwd = newRepo({ "a.txt": { content: "a" } });
    await expect(adapter.resolveCommit({ cwd, ref: "--all" })).rejects.toSatisfy((err) =>
      isGitError(err, "ref_not_found"),
    );
  });
});
