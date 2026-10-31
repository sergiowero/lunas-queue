import { randomUUID } from "node:crypto";
import { access, chmod, lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProcessRunner } from "@lunasq/adapters";
import type { RunRow } from "@lunasq/db";
import type { ReviewerName } from "@lunasq/schemas";

export type CopilotReviewerInput = {
  run: RunRow;
  worktreePath: string;
  agentId: string;
  reviewer: ReviewerName;
  instructions: string;
};

export type CopilotReviewerResult = {
  transcriptPath: string;
  output: string;
};

export interface CopilotReviewerExecutor {
  run(input: CopilotReviewerInput): Promise<CopilotReviewerResult>;
}

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const REVIEW_TIMEOUT_MS = 5 * 60 * 1000;

export class CopilotCliReviewerExecutor implements CopilotReviewerExecutor {
  readonly #processes: ProcessRunner;
  readonly #agentsPath: string;
  readonly #evidencePath: string;

  constructor(options: { processes: ProcessRunner; agentsPath: string; evidencePath: string }) {
    this.#processes = options.processes;
    this.#agentsPath = options.agentsPath;
    this.#evidencePath = options.evidencePath;
  }

  async run(input: CopilotReviewerInput): Promise<CopilotReviewerResult> {
    const sessionId = randomUUID();
    const agentId = input.agentId;
    const runDir = join(this.#evidencePath, input.run.id);
    const profileName = input.reviewer.replace("lunasq-", "");
    const profilePath = join(this.#agentsPath, `${profileName}.agent.md`);
    const profile = await lstat(profilePath).catch(() => null);
    if (!profile?.isFile() || profile.isSymbolicLink()) {
      throw new Error(`falta el perfil Copilot del revisor ${input.reviewer}: ${profilePath}`);
    }
    await access(profilePath);
    await ensurePrivateDirectory(this.#evidencePath);
    await ensurePrivateDirectory(runDir);
    const promptPath = join(runDir, `${agentId}.prompt`);
    await writeFile(promptPath, input.instructions, { encoding: "utf8", flag: "wx", mode: 0o600 });
    let result: Awaited<ReturnType<ProcessRunner["run"]>>;
    try {
      result = await this.#processes.run({
        command: [
          "copilot",
          "--agent",
          shellQuote(input.reviewer),
          "--session-id",
          shellQuote(sessionId),
          "--available-tools",
          "read",
          "search",
          "--allow-all-tools",
          "--silent",
          "<",
          shellQuote(promptPath),
        ].join(" "),
        cwd: input.worktreePath,
        envAllowlist: ["PATH", "HOME", "COPILOT_HOME", "XDG_CONFIG_HOME"],
        timeoutMs: REVIEW_TIMEOUT_MS,
      });
    } finally {
      await rm(promptPath, { force: true });
    }
    if (result.timedOut || result.exitCode !== 0) {
      throw new Error(
        `Copilot ${input.reviewer} terminó ${result.timedOut ? "por timeout" : `con exit code ${result.exitCode}`}: ${result.stderr || result.stdout}`.trim(),
      );
    }

    const output = result.stdout.trim();
    if (!output) throw new Error(`Copilot ${input.reviewer} terminó sin reporte`);

    const transcriptPath = join(runDir, `${agentId}.jsonl`);
    const timestamp = new Date().toISOString();
    const transcript = [
      {
        type: "user",
        timestamp,
        message: { content: [{ type: "text", text: input.instructions }] },
      },
      { type: "assistant", timestamp, message: { content: [{ type: "text", text: output }] } },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n");
    await writeFile(transcriptPath, `${transcript}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return { transcriptPath, output };
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`el directorio de evidencia de Copilot no es seguro: ${path}`);
  }
  await chmod(path, 0o700);
}
