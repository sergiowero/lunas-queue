// The pilot project's repo: a bare origin, the local checkout with the `main` base and the per-phase
// hooks in `lunasq/hooks` (ADR uw-10-hooks). One hook per policy: `before_verification` passes and
// `after_implementation` fails with `warn`, so the hooks view shows both results.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { git } from "./git.ts";

export interface Fixture {
  /** Remote repo (bare); the delivery's `merge` advances it directly. */
  origin: string;
  /** Project checkout: its `localPath`. */
  repo: string;
  /** Where the tasks' worktrees live. */
  worktrees: string;
}

const FILES: Record<string, { content: string; executable?: true }> = {
  "README.md": { content: "# LunasQ pilot\n" },
  "test.sh": {
    // The project suite: passes as long as no file in `work/` is empty.
    content:
      '#!/bin/sh\nfor f in work/*; do [ -s "$f" ] || { echo "empty: $f"; exit 1; }; done\necho "suite green"\n',
    executable: true,
  },
  "work/.gitkeep": { content: "x\n" },
  "lunasq/hooks/config": {
    content: `${JSON.stringify({ after_implementation: { "10-lint.sh": { policy: "warn" } } }, null, 2)}\n`,
  },
  "lunasq/hooks/before_verification/10-prepare.sh": {
    content: '#!/bin/sh\necho "preparing $LUNASQ_TASK_ID on $LUNASQ_BRANCH"\n',
    executable: true,
  },
  "lunasq/hooks/after_implementation/10-lint.sh": {
    content: '#!/bin/sh\necho "lint: 1 warning in work/"\nexit 1\n',
    executable: true,
  },
  "lunasq/hooks/after_merge/10-announce.sh": {
    content: '#!/bin/sh\necho "merged $LUNASQ_PR_URL"\n',
    executable: true,
  },
};

export function createFixture(root: string): Fixture {
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  const worktrees = join(root, "worktrees");
  mkdirSync(worktrees, { recursive: true });
  git(root, "init", "--bare", "--initial-branch=main", origin);
  git(root, "clone", "--quiet", origin, repo);
  git(repo, "checkout", "-B", "main");
  for (const [path, file] of Object.entries(FILES)) {
    const full = join(repo, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, file.content);
    if (file.executable) chmodSync(full, 0o755);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "--quiet", "-m", "chore: repo del piloto");
  git(repo, "push", "--quiet", "origin", "main");
  return { origin, repo, worktrees };
}

/**
 * Advances the origin's `main` to `branch`, as a conflict-free PR merge would. It requires
 * the branch to already descend from `main` (the delivery rebases it): a PR that does not meet it is not
 * mergeable and the pilot reports it as a failure.
 */
export function mergeIntoMain(fixture: Fixture, branch: string): void {
  try {
    git(fixture.origin, "merge-base", "--is-ancestor", "refs/heads/main", `refs/heads/${branch}`);
  } catch (error) {
    if (error instanceof Error && "status" in error && error.status === 1) {
      throw new Error(`${branch} is not a direct advance of main: the PR is not mergeable`);
    }
    throw error;
  }
  git(fixture.origin, "update-ref", "refs/heads/main", `refs/heads/${branch}`);
}
