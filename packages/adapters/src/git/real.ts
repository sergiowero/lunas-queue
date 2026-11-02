// Real git adapter: execFile with the arguments passed separately, without a shell. Paths and messages may
// come from the project configuration and must not be able to inject commands.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { EVIDENCE_DIR } from "@lunasq/schemas";
import { GitError } from "./errors.ts";
import { withTrailers } from "./trailers.ts";
import type { GitAdapter, GitCommitInfo, GitFile, RebaseResult } from "./types.ts";

/** Limit of a local command; fetch, which goes over the network, has its own. */
export const DEFAULT_GIT_TIMEOUT_MS = 60_000;
export const DEFAULT_FETCH_TIMEOUT_MS = 5 * 60_000;

const FETCH_RACE = /incorrect old value provided|cannot lock ref/;
const FETCH_RACE_ATTEMPTS = 4;

export interface RealGitOptions {
  /** Binary path (by default `git` on the PATH). */
  bin?: string;
  timeoutMs?: number;
  fetchTimeoutMs?: number;
}

interface GitRun {
  stdout: Buffer;
  stderr: string;
  exitCode: number;
}

// Pathspec that leaves LunasQ's evidence file out of the checks and of `commitAll`.
const EXCLUDE_EVIDENCE = [".", `:(exclude)${EVIDENCE_DIR}`];

const REGULAR_FILE = "100644";
const EXECUTABLE_FILE = "100755";

export class RealGit implements GitAdapter {
  private readonly bin: string;
  private readonly timeoutMs: number;
  private readonly fetchTimeoutMs: number;

  constructor(opts: RealGitOptions = {}) {
    this.bin = opts.bin ?? "git";
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
    this.fetchTimeoutMs = opts.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  }

  async fetch(input: { cwd: string; remote: string; branch: string }) {
    // The sha comes from the remote (ls-remote), not from re-reading `<remote>/<branch>` after the fetch: that
    // ref lives in the common gitdir and a worktree could move it between the fetch and the read.
    const ref = `refs/heads/${input.branch}`;
    const listed = await this.ok(input.cwd, ["ls-remote", "--end-of-options", input.remote, ref], {
      timeoutMs: this.fetchTimeoutMs,
    });
    const sha = listed.stdout
      .toString("utf8")
      .split("\n")
      .map((line) => line.split("\t"))
      .find(([, name]) => name === ref)?.[0];
    if (!sha) throw new GitError("git_failed", `${input.remote} does not have ${ref}`);
    const refspec = `+${ref}:refs/remotes/${input.remote}/${input.branch}`;
    // Two fetches of the same ref in the same repo (the after_merge hook and the dependent's worktree
    // being released) race for it and git aborts the second with "incorrect old value provided":
    // the ref is already up to date, so it is retried.
    for (let attempt = 1; ; attempt++) {
      const res = await this.run(
        input.cwd,
        ["fetch", "--quiet", "--no-tags", input.remote, refspec],
        { timeoutMs: this.fetchTimeoutMs },
      );
      if (res.exitCode === 0) break;
      if (attempt < FETCH_RACE_ATTEMPTS && FETCH_RACE.test(res.stderr)) continue;
      throw new GitError(
        "git_failed",
        `fetch en ${input.cwd} (exit ${res.exitCode}): ${res.stderr.trim()}`,
      );
    }
    return this.resolveCommit({ cwd: input.cwd, ref: sha });
  }

  async resolveCommit(input: { cwd: string; ref: string }) {
    const res = await this.run(input.cwd, [
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      `${input.ref}^{commit}`,
    ]);
    if (res.exitCode !== 0) throw new GitError("ref_not_found", `${input.ref} en ${input.cwd}`);
    return res.stdout.toString("utf8").trim();
  }

  async listFiles(input: { cwd: string; commit: string; dir: string }): Promise<GitFile[]> {
    const dir = input.dir.replace(/\/+$/, "");
    const entries = await this.lsTree(input.cwd, input.commit, `${dir}/`);
    return entries
      .filter((e) => e.mode === REGULAR_FILE || e.mode === EXECUTABLE_FILE)
      .map((e) => ({ name: e.path.slice(dir.length + 1), executable: e.mode === EXECUTABLE_FILE }));
  }

  async readFile(input: { cwd: string; commit: string; path: string }) {
    // ls-tree distinguishes "does not exist" from a real failure, which cat-file mixes under the same exit 128.
    const [entry] = await this.lsTree(input.cwd, input.commit, input.path);
    if (!entry || (entry.mode !== REGULAR_FILE && entry.mode !== EXECUTABLE_FILE)) return undefined;
    const res = await this.ok(input.cwd, ["cat-file", "blob", entry.object]);
    return res.stdout;
  }

  async isDirty(cwd: string) {
    const res = await this.ok(cwd, [
      "status",
      "--porcelain",
      "--untracked-files=all",
      "-z",
      "--",
      ...EXCLUDE_EVIDENCE,
    ]);
    return res.stdout.length > 0;
  }

  async commitAll(input: { cwd: string; message: string; trailers: Record<string, string> }) {
    if (!(await this.isDirty(input.cwd))) return null;
    await this.ok(input.cwd, ["add", "--all", "--", ...EXCLUDE_EVIDENCE]);
    return this.commitStaged(input, []);
  }

  async commitPaths(input: {
    cwd: string;
    paths: string[];
    message: string;
    trailers: Record<string, string>;
  }) {
    if (input.paths.length === 0) return null;
    // --force: the evidence file may be in a project's .gitignore.
    await this.ok(input.cwd, ["add", "--force", "--", ...input.paths]);
    const staged = await this.run(input.cwd, ["diff", "--cached", "--quiet", "--", ...input.paths]);
    if (staged.exitCode === 0) return null;
    // `-- <paths>` commits only those paths, even if there are other things in the index.
    return this.commitStaged(input, ["--only", "--", ...input.paths]);
  }

  private async commitStaged(
    input: { cwd: string; message: string; trailers: Record<string, string> },
    extra: string[],
  ) {
    // The trailers go in their own paragraph. With `--trailer`, git takes as the trailer block a
    // one-line subject with `: ` (`chore(lunasq): …`) and glues them on without a blank line.
    const trailers = Object.entries(input.trailers).map(([k, v]) => `${k}: ${v}`);
    const paragraphs = trailers.length ? ["--message", trailers.join("\n")] : [];
    try {
      await this.ok(input.cwd, [
        "commit",
        "--quiet",
        "--message",
        input.message,
        ...paragraphs,
        ...extra,
      ]);
    } catch (err) {
      // Without this the index stays staged and the next commit would see an already dirty worktree.
      await this.run(input.cwd, ["reset", "--quiet"]);
      throw err;
    }
    return this.resolveCommit({ cwd: input.cwd, ref: "HEAD" });
  }

  async rebase(input: { cwd: string; onto: string }): Promise<RebaseResult> {
    const before = await this.resolveCommit({ cwd: input.cwd, ref: "HEAD" });
    const res = await this.run(input.cwd, ["rebase", "--quiet", "--end-of-options", input.onto]);
    if (res.exitCode === 0) {
      const head = await this.resolveCommit({ cwd: input.cwd, ref: "HEAD" });
      return { status: head === before ? "up_to_date" : "rebased", head };
    }
    // A conflict leaves unmerged files; any other failure (dirty worktree, nonexistent
    // ref) does not, and there is nothing to abort there.
    const unmerged = await this.run(input.cwd, ["diff", "--name-only", "--diff-filter=U", "-z"]);
    const files = unmerged.stdout.toString("utf8").split("\0").filter(Boolean);
    if (files.length === 0) {
      throw new GitError(
        "git_failed",
        `rebase in ${input.cwd} (exit ${res.exitCode}): ${res.stderr.trim()}`,
      );
    }
    await this.ok(input.cwd, ["rebase", "--abort"]);
    return { status: "conflict", files: files.sort() };
  }

  async listCommits(input: { cwd: string; base: string }): Promise<GitCommitInfo[]> {
    return (await this.logCommits(input)).map(({ sha, message, authoredAt }) => ({
      sha,
      message,
      subject: message.split("\n")[0] ?? "",
      authoredAt,
    }));
  }

  async addTrailers(input: {
    cwd: string;
    base: string;
    trailers: Record<string, Record<string, string>>;
  }) {
    const head = await this.resolveCommit({ cwd: input.cwd, ref: "HEAD" });
    let parent = await this.resolveCommit({ cwd: input.cwd, ref: input.base });
    for (const commit of await this.logCommits(input)) {
      const message = withTrailers(commit.message, input.trailers[commit.sha] ?? {});
      // With no changes of its own or from an ancestor, the commit keeps its sha.
      if (message === commit.message && commit.parent === parent) {
        parent = commit.sha;
        continue;
      }
      const created = await this.ok(
        input.cwd,
        ["commit-tree", commit.tree, "-p", parent, "-m", message.replace(/\n+$/, "")],
        {
          env: {
            GIT_AUTHOR_NAME: commit.authorName,
            GIT_AUTHOR_EMAIL: commit.authorEmail,
            GIT_AUTHOR_DATE: commit.authorDate,
          },
        },
      );
      parent = created.stdout.toString("utf8").trim();
    }
    if (parent === head) return head;
    // The trees are the same: the index and the working tree stay clean. `head` as the previous
    // value avoids overwriting a commit someone else made in the meantime.
    await this.ok(input.cwd, ["update-ref", "-m", "lunasq: trailers", "HEAD", parent, head]);
    return parent;
  }

  async push(input: { cwd: string; remote: string; branch: string }) {
    // After a rebase the history changes: it is forced, but only if the remote is still where this
    // checkout last saw it.
    await this.ok(
      input.cwd,
      [
        "push",
        "--quiet",
        "--force-with-lease",
        "--set-upstream",
        "--end-of-options",
        input.remote,
        `HEAD:refs/heads/${input.branch}`,
      ],
      { timeoutMs: this.fetchTimeoutMs },
    );
  }

  async addDetachedWorktree(input: { cwd: string; path: string; commit: string }) {
    await this.ok(input.cwd, ["worktree", "add", "--quiet", "--detach", input.path, input.commit]);
  }

  async removeWorktree(input: { cwd: string; path: string }) {
    await this.run(input.cwd, ["worktree", "remove", "--force", input.path]);
    await this.ok(input.cwd, ["worktree", "prune"]);
  }

  private async logCommits(input: { cwd: string; base: string }) {
    const fields = ["%H", "%T", "%P", "%an", "%ae", "%aI", "%B"].join("%x1f");
    const res = await this.ok(input.cwd, [
      "log",
      "--reverse",
      `--format=${fields}%x1e`,
      "--end-of-options",
      `${input.base}..HEAD`,
    ]);
    return res.stdout
      .toString("utf8")
      .split("\x1e")
      .filter((record) => record.trim() !== "")
      .map((record) => {
        const [
          sha = "",
          tree = "",
          parents = "",
          authorName = "",
          authorEmail = "",
          date = "",
          ...rest
        ] = record.replace(/^\n/, "").split("\x1f");
        return {
          sha,
          tree,
          parent: parents.split(" ")[0] ?? "",
          authorName,
          authorEmail,
          authorDate: date,
          authoredAt: new Date(date),
          message: `${rest.join("\x1f").replace(/\n+$/, "")}\n`,
        };
      });
  }

  private async lsTree(cwd: string, commit: string, path: string) {
    const res = await this.ok(cwd, ["ls-tree", "-z", "--full-tree", commit, "--", path]);
    return res.stdout
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .map((line) => {
        // <modo> SP <tipo> SP <objeto> TAB <ruta>
        const tab = line.indexOf("\t");
        const [mode = "", , object = ""] = line.slice(0, tab).split(" ");
        return { mode, object, path: line.slice(tab + 1) };
      });
  }

  private async ok(
    cwd: string,
    args: string[],
    opts: { timeoutMs?: number; env?: Record<string, string> } = {},
  ) {
    const res = await this.run(cwd, args, opts);
    if (res.exitCode !== 0) {
      throw new GitError(
        "git_failed",
        `${args[0]} en ${cwd} (exit ${res.exitCode}): ${res.stderr.trim()}`,
      );
    }
    return res;
  }

  private run(
    cwd: string,
    args: string[],
    opts: { timeoutMs?: number; env?: Record<string, string> } = {},
  ): Promise<GitRun> {
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    return new Promise((resolve, reject) => {
      execFile(
        this.bin,
        // No LunasQ command runs repo code: neither git hooks (which the task's branch
        // may define with core.hooksPath) nor the fsmonitor from the shared config.
        ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args],
        {
          cwd,
          env: {
            ...process.env,
            // No credential prompts: a fetch that asks would hang waiting.
            GIT_TERMINAL_PROMPT: "0",
            LC_ALL: "C",
            // `git replace` from a worktree would change the content of any object in the
            // base for all the repo's checkouts (refs/replace lives in the common gitdir).
            GIT_NO_REPLACE_OBJECTS: "1",
            ...opts.env,
          },
          encoding: "buffer",
          maxBuffer: 64 * 1024 * 1024,
          timeout: timeoutMs,
          killSignal: "SIGKILL",
        },
        (err, stdout, stderr) => {
          const where = `${args[0]} en ${cwd}`;
          if (err?.killed) {
            reject(new GitError("timeout", `${where}: no response in ${timeoutMs} ms`));
            return;
          }
          if (err?.code === "ENOENT") {
            const what = existsSync(cwd) ? `${this.bin}: ${err.message}` : `${cwd} does not exist`;
            reject(new GitError("git_unavailable", what, { cause: err }));
            return;
          }
          if (err && typeof err.code !== "number") {
            reject(new GitError("git_failed", `${where}: ${err.message}`, { cause: err }));
            return;
          }
          resolve({
            stdout,
            stderr: stderr.toString("utf8"),
            exitCode: typeof err?.code === "number" ? err.code : 0,
          });
        },
      );
    });
  }
}
