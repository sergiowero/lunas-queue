import { access, chmod, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProcessRunner } from "@lunasq/adapters";
import type { ReviewerExecutor, ReviewerInput, ReviewerResult } from "./copilot-reviewer.ts";

const REVIEW_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_REVIEW_OUTPUT_BYTES = 2 * 1024 * 1024;

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export class CodexCliReviewerExecutor implements ReviewerExecutor {
  readonly #processes: ProcessRunner;
  readonly #evidencePath: string;

  constructor(options: { processes: ProcessRunner; evidencePath: string }) {
    this.#processes = options.processes;
    this.#evidencePath = options.evidencePath;
  }

  async run(input: ReviewerInput): Promise<ReviewerResult> {
    if (!/^[a-z0-9_-]{1,64}$/.test(input.agentId)) {
      throw new Error("Codex reviewer id is not a safe file name");
    }
    const runDir = join(this.#evidencePath, input.run.id);
    await ensurePrivateDirectory(this.#evidencePath);
    await ensurePrivateDirectory(runDir);
    const promptPath = join(runDir, `${input.agentId}.prompt`);
    const outputPath = join(runDir, `${input.agentId}.txt`);
    await writeFile(promptPath, input.instructions, { encoding: "utf8", flag: "wx", mode: 0o600 });
    let output: string;
    try {
      const result = await this.#processes.run({
        command: [
          "codex",
          "exec",
          "--sandbox",
          "read-only",
          "--ignore-user-config",
          "--config",
          'approval_policy="never"',
          ...(input.run.model ? ["--model", shellQuote(input.run.model)] : []),
          "--output-last-message",
          shellQuote(outputPath),
          "-",
          "<",
          shellQuote(promptPath),
        ].join(" "),
        cwd: input.worktreePath,
        envAllowlist: ["PATH", "HOME", "CODEX_HOME", "XDG_CONFIG_HOME"],
        timeoutMs: REVIEW_TIMEOUT_MS,
      });
      if (result.timedOut || result.exitCode !== 0) {
        throw new Error(
          `Codex ${input.reviewer} finished ${result.timedOut ? "by timeout" : `with exit code ${result.exitCode}`}: ${result.stderr || result.stdout}`.trim(),
        );
      }
      const info = await lstat(outputPath).catch(() => null);
      if (!info?.isFile() || info.isSymbolicLink()) {
        throw new Error(`Codex ${input.reviewer} finished without a report`);
      }
      if (info.size > MAX_REVIEW_OUTPUT_BYTES) {
        throw new Error(`Codex ${input.reviewer} report is too large to archive`);
      }
      await access(outputPath);
      output = (await readFile(outputPath, "utf8")).trim();
      if (!output) throw new Error(`Codex ${input.reviewer} finished without a report`);
    } finally {
      await Promise.all([rm(promptPath, { force: true }), rm(outputPath, { force: true })]);
    }

    const transcriptPath = join(runDir, `${input.agentId}.jsonl`);
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
    throw new Error(`the Codex evidence directory is not safe: ${path}`);
  }
  await chmod(path, 0o700);
}
