// In-memory fake of the GitHub adapter. It passes the contract suite and adds controls so
// the tests (poller, delivery) cause what a human does on GitHub: merge, close, CI, reviews.
import { GitHubError } from "./errors.ts";
import type {
  CreatePrInput,
  GitHubAdapter,
  Mergeable,
  PrCheck,
  PrLabel,
  PrReview,
  PullRequest,
  ReviewDecision,
} from "./types.ts";
import { summarizeChecks } from "./wire.ts";

export interface FakeGitHubOptions {
  /** `owner/repo` of the URLs (by default `lunasq/fake`). */
  repo?: string;
  now?: () => Date;
}

export class FakeGitHub implements GitHubAdapter {
  /** Calls to createPr that opened a PR. */
  readonly created: CreatePrInput[] = [];

  private readonly repo: string;
  private readonly now: () => Date;
  private readonly prs = new Map<string, PullRequest>();
  private readonly failures = new Map<string, Error>();
  private seq = 0;

  constructor(opts: FakeGitHubOptions = {}) {
    this.repo = opts.repo ?? "lunasq/fake";
    this.now = opts.now ?? (() => new Date());
  }

  async createPr(input: CreatePrInput): Promise<{ pr: PullRequest; created: boolean }> {
    const existing = this.#findOpen(input.head, input.base);
    if (existing) return { pr: structuredClone(existing), created: false };
    this.seq += 1;
    const pr: PullRequest = {
      number: this.seq,
      url: `https://github.com/${this.repo}/pull/${this.seq}`,
      state: "open",
      isDraft: input.draft ?? false,
      headBranch: input.head,
      baseBranch: input.base,
      mergedAt: null,
      closedAt: null,
      mergeable: "mergeable",
      checks: { status: "none", items: [] },
      reviewDecision: null,
      reviews: [],
      labels: [],
    };
    this.prs.set(pr.url, pr);
    this.created.push(structuredClone(input));
    return { pr: structuredClone(pr), created: true };
  }

  async findOpenPr(input: { head: string; base: string }): Promise<PullRequest | null> {
    const pr = this.#findOpen(input.head, input.base);
    return pr ? structuredClone(pr) : null;
  }

  async addLabels(input: { url: string; labels: PrLabel[] }): Promise<PullRequest> {
    const pr = this.#get(input.url);
    for (const { name } of input.labels) if (!pr.labels.includes(name)) pr.labels.push(name);
    return structuredClone(pr);
  }

  async getPr(url: string): Promise<PullRequest> {
    const failure = this.failures.get(url);
    if (failure) throw failure;
    return structuredClone(this.#get(url));
  }

  // Controles de test.

  merge(url: string, at = this.now()): void {
    const pr = this.#open(url);
    pr.state = "merged";
    pr.mergedAt = at;
    pr.closedAt = at;
  }

  close(url: string, at = this.now()): void {
    const pr = this.#open(url);
    pr.state = "closed";
    pr.closedAt = at;
  }

  reopen(url: string): void {
    const pr = this.#get(url);
    if (pr.state !== "closed") throw new Error(`PR ${url} is not closed`);
    pr.state = "open";
    pr.closedAt = null;
  }

  /** What GitHub computes when the base advances: conflicting if another merge clashed with the PR. */
  setMergeable(url: string, mergeable: Mergeable): void {
    this.#get(url).mergeable = mergeable;
  }

  setChecks(url: string, items: PrCheck[]): void {
    this.#get(url).checks = { status: summarizeChecks(items), items: structuredClone(items) };
  }

  addReview(url: string, review: PrReview, decision?: ReviewDecision): void {
    const pr = this.#get(url);
    pr.reviews.push(structuredClone(review));
    if (decision !== undefined) pr.reviewDecision = decision;
  }

  /** getPr of that URL throws `error` until it is called with null. */
  failGetPr(url: string, error: Error | null): void {
    if (error) this.failures.set(url, error);
    else this.failures.delete(url);
  }

  #findOpen(head: string, base: string): PullRequest | undefined {
    return [...this.prs.values()].find(
      (pr) => pr.state === "open" && pr.headBranch === head && pr.baseBranch === base,
    );
  }

  #get(url: string): PullRequest {
    const pr = this.prs.get(url);
    if (!pr) throw new GitHubError("not_found", `PR ${url} does not exist`);
    return pr;
  }

  #open(url: string): PullRequest {
    const pr = this.#get(url);
    if (pr.state !== "open") throw new Error(`PR ${url} is not open`);
    return pr;
  }
}
