// Real GitHub adapter on top of the `gh` CLI (ADR uw-14-adapter-github). Values go as
// `--flag=value` so a title that starts with `-` is not read as another option.
import { GhCli, type GhCliOptions } from "./cli.ts";
import { GitHubError, isGitHubError } from "./errors.ts";
import type { CreatePrInput, GitHubAdapter, PrLabel, PullRequest } from "./types.ts";
import { PR_FIELDS, parsePr, parsePrList } from "./wire.ts";

const PR_URL = /^https:\/\/\S+\/pull\/\d+$/;

export type RealGitHubOptions = GhCliOptions;

export class RealGitHub implements GitHubAdapter {
  private readonly cli: GhCli;

  constructor(opts: RealGitHubOptions = {}) {
    this.cli = new GhCli(opts);
  }

  async createPr(input: CreatePrInput): Promise<{ pr: PullRequest; created: boolean }> {
    const existing = await this.findOpenPr(input);
    if (existing) return { pr: existing, created: false };

    const args = [
      "pr",
      "create",
      `--head=${input.head}`,
      `--base=${input.base}`,
      `--title=${input.title}`,
      "--body-file=-",
      ...(input.draft ? ["--draft"] : []),
    ];
    let stdout: string;
    try {
      stdout = await this.cli.text(args, { cwd: input.cwd, input: input.body });
    } catch (err) {
      // Another process opened it between the search and the create.
      if (isGitHubError(err, "gh_failed") && /already exists/i.test(err.message)) {
        const raced = await this.findOpenPr(input);
        if (raced) return { pr: raced, created: false };
      }
      throw err;
    }
    // gh prints the PR URL on the last line. Without it getPr is not called: `gh pr view`
    // with an empty argument would read the PR of the server directory's branch.
    const url = stdout.trim().split("\n").at(-1)?.trim() ?? "";
    if (!PR_URL.test(url)) {
      throw new GitHubError("invalid_output", `pr create without a PR URL: ${stdout}`);
    }
    return { pr: await this.getPr(url), created: true };
  }

  async addLabels(input: { cwd: string; url: string; labels: PrLabel[] }): Promise<PullRequest> {
    if (!PR_URL.test(input.url)) {
      throw new GitHubError("not_found", `not a PR URL: ${input.url}`);
    }
    for (const label of input.labels) {
      // --force: if the label already exists, it updates it instead of failing.
      await this.cli.text(
        [
          "label",
          "create",
          label.name,
          "--force",
          ...(label.color ? [`--color=${label.color}`] : []),
          ...(label.description ? [`--description=${label.description}`] : []),
        ],
        { cwd: input.cwd },
      );
    }
    if (input.labels.length > 0) {
      await this.cli.text(
        ["pr", "edit", input.url, ...input.labels.map((l) => `--add-label=${l.name}`)],
        { cwd: input.cwd },
      );
    }
    return this.getPr(input.url);
  }

  async findOpenPr(input: {
    cwd: string;
    head: string;
    base: string;
  }): Promise<PullRequest | null> {
    const raw = await this.cli.json(
      [
        "pr",
        "list",
        `--head=${input.head}`,
        `--base=${input.base}`,
        "--state=open",
        `--json=${PR_FIELDS}`,
        "--limit=1",
      ],
      { cwd: input.cwd },
    );
    return parsePrList(raw)[0] ?? null;
  }

  async getPr(url: string): Promise<PullRequest> {
    // URLs only: a number or a branch would be resolved against the current directory's repo.
    if (!PR_URL.test(url)) throw new GitHubError("not_found", `not a PR URL: ${url}`);
    return parsePr(await this.cli.json(["pr", "view", url, `--json=${PR_FIELDS}`]));
  }
}
