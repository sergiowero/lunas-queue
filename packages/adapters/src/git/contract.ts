// Contract suite of the git adapter: it runs against the fake and against real git (both in
// `pnpm test`; real git only needs temporary repos).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isGitError } from "./errors.ts";
import type { GitAdapter } from "./types.ts";

export type RepoFiles = Record<string, { content: string; executable?: boolean }>;

export interface GitContractHarness {
  adapter: GitAdapter;
  /** A checkout with an `origin` remote whose `main` branch has `files`, already fetched. */
  newRepo(files: RepoFiles): Promise<string>;
  /** A new commit on the remote's `main` with `files` (replaces the tree); the checkout does not fetch it. */
  pushToRemote(cwd: string, files: RepoFiles): Promise<void>;
  /** Writes into the checkout's working tree without committing. */
  writeWorkingFile(cwd: string, path: string, content: string): Promise<void>;
  /** Paths tracked at HEAD. */
  trackedFiles(cwd: string): Promise<string[]>;
  /** A path that does not exist yet, for a temporary worktree. */
  freePath(): Promise<string>;
  /** Creates the local branch `branch` at HEAD and switches to it. */
  checkoutBranch(cwd: string, branch: string): Promise<void>;
  /** Sha of `branch` on the remote `origin`; null if it does not exist. */
  remoteBranch(cwd: string, branch: string): Promise<string | null>;
  /** Full message of the commit at HEAD. */
  headMessage(cwd: string): Promise<string>;
  cleanup(): Promise<void>;
}

const hooks: RepoFiles = {
  "README.md": { content: "repo\n" },
  "lunasq/hooks/config": { content: "{}\n" },
  "lunasq/hooks/before_delivery/10-bump": { content: "#!/bin/sh\necho bump\n", executable: true },
  "lunasq/hooks/before_delivery/notes.txt": { content: "no es hook\n" },
  "lunasq/hooks/before_delivery/sub/20-nested": { content: "#!/bin/sh\n", executable: true },
};

export function gitContract(name: string, setup: () => Promise<GitContractHarness>): void {
  // Each test builds real repos and remotes; under the gate's load they exceed the default 5s.
  describe(`git adapter contract: ${name}`, { timeout: 30_000 }, () => {
    let h: GitContractHarness;
    let git: GitAdapter;

    beforeAll(async () => {
      h = await setup();
      git = h.adapter;
    });

    afterAll(async () => {
      await h?.cleanup();
    });

    describe("base branch", () => {
      it("fetch brings the remote's new commit and resolveCommit gives its sha", async () => {
        const cwd = await h.newRepo(hooks);
        const before = await git.resolveCommit({ cwd, ref: "origin/main" });
        expect(before).toMatch(/^[0-9a-f]{40}$/);

        await h.pushToRemote(cwd, { ...hooks, "CHANGELOG.md": { content: "v2\n" } });
        expect(await git.resolveCommit({ cwd, ref: "origin/main" })).toBe(before);

        const fetched = await git.fetch({ cwd, remote: "origin", branch: "main" });
        const after = await git.resolveCommit({ cwd, ref: "origin/main" });
        expect(fetched).toBe(after);
        expect(after).toMatch(/^[0-9a-f]{40}$/);
        expect(after).not.toBe(before);
      });

      it("fetch of a nonexistent branch and resolveCommit of a nonexistent ref fail", async () => {
        const cwd = await h.newRepo(hooks);
        await expect(git.fetch({ cwd, remote: "origin", branch: "no-existe" })).rejects.toSatisfy(
          (err) => isGitError(err, "git_failed"),
        );
        await expect(git.resolveCommit({ cwd, ref: "origin/no-existe" })).rejects.toSatisfy((err) =>
          isGitError(err, "ref_not_found"),
        );
      });

      it("listFiles gives the directory's direct files with their execute bit", async () => {
        const cwd = await h.newRepo(hooks);
        const commit = await git.resolveCommit({ cwd, ref: "origin/main" });
        const files = await git.listFiles({ cwd, commit, dir: "lunasq/hooks/before_delivery" });
        expect(files.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
          { name: "10-bump", executable: true },
          { name: "notes.txt", executable: false },
        ]);
        expect(await git.listFiles({ cwd, commit, dir: "lunasq/hooks/after_merge" })).toEqual([]);
      });

      it("readFile reads the commit; undefined if it does not exist or is a directory", async () => {
        const cwd = await h.newRepo(hooks);
        const commit = await git.resolveCommit({ cwd, ref: "origin/main" });
        const content = await git.readFile({
          cwd,
          commit,
          path: "lunasq/hooks/before_delivery/10-bump",
        });
        expect(content?.toString("utf8")).toBe("#!/bin/sh\necho bump\n");
        expect(await git.readFile({ cwd, commit, path: "lunasq/hooks/nada" })).toBeUndefined();
        expect(await git.readFile({ cwd, commit, path: "lunasq/hooks" })).toBeUndefined();
      });

      it("working tree changes are not seen in the commit", async () => {
        const cwd = await h.newRepo(hooks);
        const commit = await git.resolveCommit({ cwd, ref: "origin/main" });
        await h.writeWorkingFile(cwd, "lunasq/hooks/before_delivery/10-bump", "rm -rf /\n");
        await h.writeWorkingFile(cwd, "lunasq/hooks/before_delivery/05-evil", "rm -rf /\n");

        const files = await git.listFiles({ cwd, commit, dir: "lunasq/hooks/before_delivery" });
        expect(files.map((f) => f.name)).not.toContain("05-evil");
        const content = await git.readFile({
          cwd,
          commit,
          path: "lunasq/hooks/before_delivery/10-bump",
        });
        expect(content?.toString("utf8")).toBe("#!/bin/sh\necho bump\n");
      });
    });

    describe("temporary worktrees", () => {
      it("addDetachedWorktree opens the commit at another path and removeWorktree deletes it", async () => {
        const cwd = await h.newRepo(hooks);
        const commit = await git.resolveCommit({ cwd, ref: "origin/main" });
        const path = await h.freePath();

        await git.addDetachedWorktree({ cwd, path, commit });
        expect(await git.resolveCommit({ cwd: path, ref: "HEAD" })).toBe(commit);
        expect(await git.isDirty(path)).toBe(false);

        await git.removeWorktree({ cwd, path });
        await git.removeWorktree({ cwd, path });
        await expect(git.isDirty(path)).rejects.toSatisfy((err) =>
          isGitError(err, "git_unavailable"),
        );
      });
    });

    describe("committing changes", () => {
      it("isDirty sees new and modified files", async () => {
        const cwd = await h.newRepo(hooks);
        expect(await git.isDirty(cwd)).toBe(false);
        await h.writeWorkingFile(cwd, "VERSION", "1.0.1\n");
        expect(await git.isDirty(cwd)).toBe(true);
      });

      it("commitAll commits everything with the trailers and does not create empty commits", async () => {
        const cwd = await h.newRepo(hooks);
        expect(
          await git.commitAll({ cwd, message: "nada", trailers: { "LunasQ-Task": "t1" } }),
        ).toBeNull();

        await h.writeWorkingFile(cwd, "VERSION", "1.0.1\n");
        const sha = await git.commitAll({
          cwd,
          message: "chore(lunasq): hooks before_delivery",
          trailers: { "LunasQ-Task": "t1", "LunasQ-Run": "r1" },
        });
        expect(sha).toMatch(/^[0-9a-f]{40}$/);
        expect(sha).toBe(await git.resolveCommit({ cwd, ref: "HEAD" }));
        expect(await git.isDirty(cwd)).toBe(false);

        const message = await h.headMessage(cwd);
        expect(message).toMatch(/^chore\(lunasq\): hooks before_delivery\n/);
        expect(message).toMatch(/\n\nLunasQ-Task: t1\nLunasQ-Run: r1\n*$/);

        expect(await git.commitAll({ cwd, message: "otra", trailers: {} })).toBeNull();
      });

      it("isDirty and commitAll ignore lunasq/tasks/, which belongs to LunasQ", async () => {
        const cwd = await h.newRepo(hooks);
        await h.writeWorkingFile(cwd, "lunasq/tasks/t1.md", "# evidencia\n");
        expect(await git.isDirty(cwd)).toBe(false);
        expect(
          await git.commitAll({ cwd, message: "nada", trailers: { "LunasQ-Task": "t1" } }),
        ).toBeNull();

        // An agent change does count, and its commit does not drag in the evidence.
        await h.writeWorkingFile(cwd, "VERSION", "1.0.1\n");
        expect(await git.isDirty(cwd)).toBe(true);
        const before = await git.resolveCommit({ cwd, ref: "HEAD" });
        const sha = await git.commitAll({ cwd, message: "cambio", trailers: {} });
        expect(sha).not.toBe(before);
        expect(await git.isDirty(cwd)).toBe(false);
        expect(await h.trackedFiles(cwd)).not.toContain("lunasq/tasks/t1.md");
      });
    });

    describe("integration with the base branch", () => {
      const commit = async (cwd: string, path: string, content: string, message: string) => {
        await h.writeWorkingFile(cwd, path, content);
        const sha = await git.commitAll({ cwd, message, trailers: {} });
        if (!sha) throw new Error("the test commit created nothing");
        return sha;
      };

      it("rebase with nothing new on the base does not touch the branch", async () => {
        const cwd = await h.newRepo(hooks);
        await h.checkoutBranch(cwd, "lunasq/t1");
        const mine = await commit(cwd, "VERSION", "1\n", "feat: version");
        expect(await git.rebase({ cwd, onto: "origin/main" })).toEqual({
          status: "up_to_date",
          head: mine,
        });
      });

      it("rebase puts the branch's commits on top of the new base", async () => {
        const cwd = await h.newRepo(hooks);
        await h.checkoutBranch(cwd, "lunasq/t1");
        await commit(cwd, "VERSION", "1\n", "feat: version");
        await h.pushToRemote(cwd, { ...hooks, "CHANGELOG.md": { content: "v2\n" } });
        await git.fetch({ cwd, remote: "origin", branch: "main" });

        const result = await git.rebase({ cwd, onto: "origin/main" });
        expect(result.status).toBe("rebased");
        if (result.status !== "rebased") return;
        expect(result.head).toBe(await git.resolveCommit({ cwd, ref: "HEAD" }));
        expect(await h.trackedFiles(cwd)).toEqual(
          expect.arrayContaining(["VERSION", "CHANGELOG.md"]),
        );
        expect(await git.isDirty(cwd)).toBe(false);
        // Already integrated, repeating it does nothing.
        expect((await git.rebase({ cwd, onto: "origin/main" })).status).toBe("up_to_date");
      });

      it("rebase with a conflict aborts it and leaves the worktree as it was", async () => {
        const cwd = await h.newRepo(hooks);
        await h.checkoutBranch(cwd, "lunasq/t1");
        const mine = await commit(cwd, "README.md", "mi cambio\n", "feat: readme");
        await h.pushToRemote(cwd, { ...hooks, "README.md": { content: "su cambio\n" } });
        await git.fetch({ cwd, remote: "origin", branch: "main" });

        expect(await git.rebase({ cwd, onto: "origin/main" })).toEqual({
          status: "conflict",
          files: ["README.md"],
        });
        expect(await git.resolveCommit({ cwd, ref: "HEAD" })).toBe(mine);
        expect(await git.isDirty(cwd)).toBe(false);
      });

      it("rebase with a dirty worktree fails without touching anything", async () => {
        const cwd = await h.newRepo(hooks);
        await h.checkoutBranch(cwd, "lunasq/t1");
        await commit(cwd, "VERSION", "1\n", "feat: version");
        await h.pushToRemote(cwd, { ...hooks, "CHANGELOG.md": { content: "v2\n" } });
        await git.fetch({ cwd, remote: "origin", branch: "main" });
        await h.writeWorkingFile(cwd, "VERSION", "2\n");

        await expect(git.rebase({ cwd, onto: "origin/main" })).rejects.toSatisfy((err) =>
          isGitError(err, "git_failed"),
        );
      });

      it("listCommits gives the commits of base..HEAD from oldest to newest", async () => {
        const cwd = await h.newRepo(hooks);
        const base = await git.resolveCommit({ cwd, ref: "origin/main" });
        await h.checkoutBranch(cwd, "lunasq/t1");
        expect(await git.listCommits({ cwd, base })).toEqual([]);
        const first = await commit(cwd, "a.txt", "a\n", "feat: a\n\ncuerpo");
        const second = await commit(cwd, "b.txt", "b\n", "feat: b");

        const commits = await git.listCommits({ cwd, base });
        expect(commits.map((c) => c.sha)).toEqual([first, second]);
        expect(commits.map((c) => c.subject)).toEqual(["feat: a", "feat: b"]);
        expect(commits[0]?.message).toMatch(/^feat: a\n\ncuerpo/);
        expect(commits[0]?.authoredAt).toBeInstanceOf(Date);
        expect(Number.isNaN(commits[0]?.authoredAt.getTime())).toBe(false);
      });

      it("addTrailers rewrites the given commits and repeating it changes nothing", async () => {
        const cwd = await h.newRepo(hooks);
        const base = await git.resolveCommit({ cwd, ref: "origin/main" });
        await h.checkoutBranch(cwd, "lunasq/t1");
        const first = await commit(cwd, "a.txt", "a\n", "feat(x): a");
        const second = await commit(cwd, "b.txt", "b\n", "feat: b");

        const head = await git.addTrailers({
          cwd,
          base,
          trailers: { [first]: { "LunasQ-Task": "t1", "LunasQ-Run": "r1" } },
        });
        expect(head).toBe(await git.resolveCommit({ cwd, ref: "HEAD" }));
        expect(head).not.toBe(second);
        expect(await git.isDirty(cwd)).toBe(false);
        expect(await h.trackedFiles(cwd)).toEqual(expect.arrayContaining(["a.txt", "b.txt"]));

        const commits = await git.listCommits({ cwd, base });
        expect(commits.map((c) => c.subject)).toEqual(["feat(x): a", "feat: b"]);
        expect(commits[0]?.message).toMatch(/^feat\(x\): a\n\nLunasQ-Task: t1\nLunasQ-Run: r1\n*$/);
        expect(commits[1]?.message).not.toContain("LunasQ-");

        // Second time: the shas are different, but the keys are already there and nothing is added.
        const [rewritten] = commits;
        const again = await git.addTrailers({
          cwd,
          base,
          trailers: { [rewritten?.sha ?? ""]: { "LunasQ-Task": "t1", "LunasQ-Run": "r2" } },
        });
        expect(again).toBe(head);
      });

      it("push publishes HEAD on the remote's branch and repeats after rewriting history", async () => {
        const cwd = await h.newRepo(hooks);
        const base = await git.resolveCommit({ cwd, ref: "origin/main" });
        await h.checkoutBranch(cwd, "lunasq/t1");
        const mine = await commit(cwd, "a.txt", "a\n", "feat: a");
        expect(await h.remoteBranch(cwd, "lunasq/t1")).toBeNull();

        await git.push({ cwd, remote: "origin", branch: "lunasq/t1" });
        expect(await h.remoteBranch(cwd, "lunasq/t1")).toBe(mine);
        // Same HEAD: it does not fail.
        await git.push({ cwd, remote: "origin", branch: "lunasq/t1" });

        const head = await git.addTrailers({
          cwd,
          base,
          trailers: { [mine]: { "LunasQ-Task": "t1" } },
        });
        await git.push({ cwd, remote: "origin", branch: "lunasq/t1" });
        expect(await h.remoteBranch(cwd, "lunasq/t1")).toBe(head);
      });

      it("push to a nonexistent remote fails with git_failed", async () => {
        const cwd = await h.newRepo(hooks);
        await h.checkoutBranch(cwd, "lunasq/t1");
        await expect(git.push({ cwd, remote: "no-existe", branch: "lunasq/t1" })).rejects.toSatisfy(
          (err) => isGitError(err, "git_failed"),
        );
      });
    });

    describe("commitPaths", () => {
      it("commits only those paths with the trailers and does not create empty commits", async () => {
        const cwd = await h.newRepo(hooks);
        await h.writeWorkingFile(cwd, "lunasq/tasks/t1.md", "# evidencia\n");
        await h.writeWorkingFile(cwd, "VERSION", "1.0.1\n");

        const sha = await git.commitPaths({
          cwd,
          paths: ["lunasq/tasks/t1.md"],
          message: "chore(lunasq): evidencia",
          trailers: { "LunasQ-Task": "t1", "LunasQ-Run": "r1" },
        });
        expect(sha).toMatch(/^[0-9a-f]{40}$/);
        expect(sha).toBe(await git.resolveCommit({ cwd, ref: "HEAD" }));
        expect(await h.trackedFiles(cwd)).toContain("lunasq/tasks/t1.md");
        expect(await h.trackedFiles(cwd)).not.toContain("VERSION");
        // The other change is still uncommitted.
        expect(await git.isDirty(cwd)).toBe(true);

        const message = await h.headMessage(cwd);
        expect(message).toMatch(/^chore\(lunasq\): evidencia\n/);
        expect(message).toMatch(/\n\nLunasQ-Task: t1\nLunasQ-Run: r1\n*$/);

        expect(
          await git.commitPaths({
            cwd,
            paths: ["lunasq/tasks/t1.md"],
            message: "otra",
            trailers: {},
          }),
        ).toBeNull();
      });

      it("commits a new version of the already tracked file", async () => {
        const cwd = await h.newRepo(hooks);
        const input = { cwd, paths: ["lunasq/tasks/t1.md"], message: "evidencia", trailers: {} };
        await h.writeWorkingFile(cwd, "lunasq/tasks/t1.md", "uno\n");
        const first = await git.commitPaths(input);
        await h.writeWorkingFile(cwd, "lunasq/tasks/t1.md", "uno\ndos\n");
        const second = await git.commitPaths(input);
        expect(second).not.toBe(first);
        expect(second).toBe(await git.resolveCommit({ cwd, ref: "HEAD" }));
      });
    });
  });
}
