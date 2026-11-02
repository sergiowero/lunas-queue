// GitHub adapter port (ADR uw-14-adapter-github). Only through the `gh` CLI with the machine's
// authenticated session (docs/tech-stack.md). RealGitHub and FakeGitHub implement it and pass the
// misma suite.
import type { PrState } from "@lunasq/schemas";

/** CI summary: none without checks; failure if any failed; pending if any has not finished. */
export type ChecksStatus = "none" | "pending" | "success" | "failure";

export type CheckStatus = "pending" | "success" | "failure" | "skipped";

export interface PrCheck {
  name: string;
  status: CheckStatus;
  url: string | null;
}

export type ReviewState = "approved" | "changes_requested" | "commented" | "dismissed" | "pending";

export interface PrReview {
  author: string;
  state: ReviewState;
  submittedAt: Date | null;
}

/**
 * Whether the PR can be merged with the base: conflicting if GitHub detects conflicts; unknown while
 * GitHub has not computed it (it computes it in the background after a push to the base or to the PR).
 */
export type Mergeable = "mergeable" | "conflicting" | "unknown";

/** null if the repo does not require reviews. */
export type ReviewDecision = "approved" | "changes_requested" | "review_required" | null;

export interface PullRequest {
  number: number;
  url: string;
  state: PrState;
  isDraft: boolean;
  headBranch: string;
  baseBranch: string;
  mergedAt: Date | null;
  closedAt: Date | null;
  mergeable: Mergeable;
  checks: { status: ChecksStatus; items: PrCheck[] };
  reviewDecision: ReviewDecision;
  reviews: PrReview[];
  /** Names of the PR's labels. */
  labels: string[];
}

export interface PrLabel {
  name: string;
  /** Hex color without `#`, to create the label if the repo does not have it. */
  color?: string;
  description?: string;
}

export interface CreatePrInput {
  /** Repo checkout (the task's worktree); `gh` takes the repo from its remote. */
  cwd: string;
  /** Branch already published on the remote. */
  head: string;
  base: string;
  title: string;
  body: string;
  draft?: boolean;
}

export interface GitHubAdapter {
  /**
   * Opens the PR from `head` to `base`. Idempotent: if one is already open, it returns it with
   * `created: false`. A closed or merged one does not count: another is opened.
   */
  createPr(input: CreatePrInput): Promise<{ pr: PullRequest; created: boolean }>;
  /** Open PR from `head` to `base`, or null. */
  findOpenPr(input: { cwd: string; head: string; base: string }): Promise<PullRequest | null>;
  /**
   * Adds labels to the PR, creating them in the repo if missing. Idempotent: repeating it does not duplicate.
   * `cwd` is a checkout of the repo, from which `gh` takes the remote.
   */
  addLabels(input: { cwd: string; url: string; labels: PrLabel[] }): Promise<PullRequest>;
  /** State, CI and reviews of a PR by its URL. Throws GitHubError `not_found` if it does not exist. */
  getPr(url: string): Promise<PullRequest>;
}
