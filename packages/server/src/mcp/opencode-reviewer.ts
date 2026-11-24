import { chmod, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  OPENCODE_CONFIG_ENV,
  OPENCODE_DISABLE_PROJECT_CONFIG_ENV,
  opencodeReviewerConfig,
  type ProcessRunner,
} from "@lunasq/adapters";
import type { ReviewerExecutor, ReviewerInput, ReviewerResult } from "./copilot-reviewer.ts";

const REVIEW_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_REVIEW_OUTPUT_BYTES = 2 * 1024 * 1024;

/**
 * What the reviewer process inherits: enough for OpenCode to find its own auth and the usual provider
 * keys, and nothing else (no `GH_TOKEN`, no LunasQ run token).
 */
const ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_DIR",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "OPENROUTER_API_KEY",
  "GROQ_API_KEY",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
];

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * Verification reviewer on OpenCode: `opencode run` in the worktree with read-only permissions
 * (`opencodeReviewerConfig`), the prompt from a private file on stdin and its JSON event stream in a
 * private file. The report is the final assistant message; nothing is recorded if there is none.
 */
export class OpencodeCliReviewerExecutor implements ReviewerExecutor {
  readonly #processes: ProcessRunner;
  readonly #evidencePath: string;

  constructor(options: { processes: ProcessRunner; evidencePath: string }) {
    this.#processes = options.processes;
    this.#evidencePath = options.evidencePath;
  }

  async run(input: ReviewerInput): Promise<ReviewerResult> {
    if (!/^[a-z0-9_-]{1,64}$/.test(input.agentId)) {
      throw new Error("OpenCode reviewer id is not a safe file name");
    }
    const runDir = join(this.#evidencePath, input.run.id);
    await ensurePrivateDirectory(this.#evidencePath);
    await ensurePrivateDirectory(runDir);
    const promptPath = join(runDir, `${input.agentId}.prompt`);
    const eventsPath = join(runDir, `${input.agentId}.events`);
    await writeFile(promptPath, input.instructions, { encoding: "utf8", flag: "wx", mode: 0o600 });
    let output: string;
    try {
      // The events file exists with mode 0600 before the shell redirects into it.
      await writeFile(eventsPath, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
      const result = await this.#processes.run({
        command: [
          "opencode",
          "run",
          "--pure",
          "--format",
          "json",
          ...(input.run.model ? ["--model", shellQuote(input.run.model)] : []),
          "<",
          shellQuote(promptPath),
          ">",
          shellQuote(eventsPath),
        ].join(" "),
        cwd: input.worktreePath,
        env: {
          [OPENCODE_CONFIG_ENV]: JSON.stringify(opencodeReviewerConfig()),
          // The worktree is the task's code: its opencode.json or .opencode/ must not widen the
          // reviewer's permissions nor start local MCP servers.
          [OPENCODE_DISABLE_PROJECT_CONFIG_ENV]: "1",
        },
        envAllowlist: ENV_ALLOWLIST,
        timeoutMs: REVIEW_TIMEOUT_MS,
      });
      if (result.timedOut || result.exitCode !== 0) {
        throw new Error(
          `OpenCode ${input.reviewer} finished ${result.timedOut ? "by timeout" : `with exit code ${result.exitCode}`}: ${result.stderr || result.stdout}`.trim(),
        );
      }
      const info = await lstat(eventsPath).catch(() => null);
      if (!info?.isFile() || info.isSymbolicLink()) {
        throw new Error(`OpenCode ${input.reviewer} finished without a report`);
      }
      if (info.size > MAX_REVIEW_OUTPUT_BYTES * 8) {
        throw new Error(`OpenCode ${input.reviewer} report is too large to archive`);
      }
      output = finalMessage(await readFile(eventsPath, "utf8"));
      if (!output) throw new Error(`OpenCode ${input.reviewer} finished without a report`);
      if (Buffer.byteLength(output) > MAX_REVIEW_OUTPUT_BYTES) {
        throw new Error(`OpenCode ${input.reviewer} report is too large to archive`);
      }
    } finally {
      await Promise.all([rm(promptPath, { force: true }), rm(eventsPath, { force: true })]);
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

/**
 * The text of the last assistant message in `opencode run --format json`'s event stream (one JSON
 * object per line). Lines that do not parse are skipped.
 */
export function finalMessage(events: string): string {
  const parts: { messageId: string; text: string }[] = [];
  for (const line of events.split("\n")) {
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const e = event as { type?: unknown; part?: { messageID?: unknown; text?: unknown } };
    if (e.type !== "text" || typeof e.part?.text !== "string") continue;
    parts.push({ messageId: String(e.part.messageID ?? ""), text: e.part.text });
  }
  const last = parts.at(-1);
  if (!last) return "";
  return parts
    .filter((part) => part.messageId === last.messageId)
    .map((part) => part.text)
    .join("")
    .trim();
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`the OpenCode evidence directory is not safe: ${path}`);
  }
  await chmod(path, 0o700);
}
