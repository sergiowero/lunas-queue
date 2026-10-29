// Adapter real de GitHub sobre el CLI `gh` (ADR 0015). Los valores van como `--flag=valor` para
// que un título que empieza con `-` no se lea como otra opción.
import { GhCli, type GhCliOptions } from "./cli.ts";
import { isGitHubError } from "./errors.ts";
import type { CreatePrInput, GitHubAdapter, PullRequest } from "./types.ts";
import { PR_FIELDS, parsePr, parsePrList } from "./wire.ts";

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
      // Otro proceso lo abrió entre la búsqueda y el create.
      if (isGitHubError(err, "gh_failed") && /already exists/i.test(err.message)) {
        const raced = await this.findOpenPr(input);
        if (raced) return { pr: raced, created: false };
      }
      throw err;
    }
    // gh imprime la URL del PR en la última línea.
    const url = stdout.trim().split("\n").at(-1)?.trim() ?? "";
    return { pr: await this.getPr(url), created: true };
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
    return parsePr(await this.cli.json(["pr", "view", url, `--json=${PR_FIELDS}`]));
  }
}
