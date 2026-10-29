// Adapter real de GitHub sobre el CLI `gh` (ADR 0015). Los valores van como `--flag=valor` para
// que un título que empieza con `-` no se lea como otra opción.
import { GhCli, type GhCliOptions } from "./cli.ts";
import { GitHubError, isGitHubError } from "./errors.ts";
import type { CreatePrInput, GitHubAdapter, PullRequest } from "./types.ts";
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
      // Otro proceso lo abrió entre la búsqueda y el create.
      if (isGitHubError(err, "gh_failed") && /already exists/i.test(err.message)) {
        const raced = await this.findOpenPr(input);
        if (raced) return { pr: raced, created: false };
      }
      throw err;
    }
    // gh imprime la URL del PR en la última línea. Sin ella no se llama a getPr: `gh pr view`
    // con un argumento vacío leería el PR del branch del directorio del servidor.
    const url = stdout.trim().split("\n").at(-1)?.trim() ?? "";
    if (!PR_URL.test(url)) {
      throw new GitHubError("invalid_output", `pr create sin URL del PR: ${stdout}`);
    }
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
    // Solo URLs: un número o un branch se resolverían contra el repo del directorio actual.
    if (!PR_URL.test(url)) throw new GitHubError("not_found", `no es la URL de un PR: ${url}`);
    return parsePr(await this.cli.json(["pr", "view", url, `--json=${PR_FIELDS}`]));
  }
}
