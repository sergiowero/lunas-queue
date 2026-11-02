// Source of the evidence file's transcripts (docs/design.md §Evidence file, ADR
// uw-24-archivo-evidencia). Claude Code stores each session in
// `~/.claude/projects/<cwd with non-alphanumerics → "-">/<session-id>.jsonl` and deletes the
// transcripts when their retention expires; LunasQ copies them when the Run closes.
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import type { RunRow, RunSubagentRow } from "@lunasq/db";
import type { AgentKind } from "@lunasq/schemas";

export type TranscriptRequest = {
  run: RunRow;
  worktreePath: string;
  subagents: RunSubagentRow[];
};

/** `jsonl` is null if it could not be read; `note` says why. */
export type RawTranscript = { title: string; jsonl: string | null; note?: string };

export interface TranscriptSource {
  /** The agent's session first and then one transcript per subagent. */
  forRun(request: TranscriptRequest): Promise<RawTranscript[]>;
}

/** Without transcripts: the evidence file is left without that part. */
export class NoTranscripts implements TranscriptSource {
  async forRun(): Promise<RawTranscript[]> {
    return [];
  }
}

/** 32 MiB: a larger transcript does not usefully fit in a PR. */
export const DEFAULT_TRANSCRIPT_MAX_BYTES = 32 * 1024 * 1024;

/** Name of the project directory Claude Code uses for a cwd. */
export const projectDirName = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, "-");

export interface ClaudeTranscriptSourceOptions {
  /** By default `~/.claude`. */
  claudeDir?: string;
  maxBytes?: number;
}

type Read = { jsonl: string } | { jsonl: null; note: string };

export class ClaudeTranscriptSource implements TranscriptSource {
  readonly #projectsDir: string;
  readonly #maxBytes: number;

  constructor(opts: ClaudeTranscriptSourceOptions = {}) {
    this.#projectsDir = join(opts.claudeDir ?? join(homedir(), ".claude"), "projects");
    this.#maxBytes = opts.maxBytes ?? DEFAULT_TRANSCRIPT_MAX_BYTES;
  }

  async forRun({ run, worktreePath, subagents }: TranscriptRequest): Promise<RawTranscript[]> {
    const out: RawTranscript[] = [await this.#session(run, worktreePath)];
    for (const sub of subagents) {
      const title = `Subagent ${sub.agentType} (${sub.agentId})`;
      if (!sub.transcriptPath) {
        out.push({ title, jsonl: null, note: "no transcript: the subagent did not finish" });
        continue;
      }
      out.push({ title, ...(await this.#subagent(sub.transcriptPath, worktreePath)) });
    }
    return out;
  }

  async #session(run: RunRow, worktreePath: string): Promise<RawTranscript> {
    const title = "Agent session";
    if (!run.agentSession) return { title, jsonl: null, note: "Run without an agent session" };
    // Claude Code names the directory with the already resolved cwd; the worktree may come through a symlink.
    const cwds = [worktreePath, await realpath(worktreePath).catch(() => worktreePath)];
    for (const cwd of new Set(cwds)) {
      const path = join(this.#projectsDir, projectDirName(cwd), `${run.agentSession}.jsonl`);
      const read = await this.#read(path);
      if (read.jsonl !== null || read.note.startsWith("too large")) return { title, ...read };
    }
    return {
      title,
      jsonl: null,
      note: `transcript of session ${run.agentSession} not found`,
    };
  }

  async #subagent(path: string, worktreePath: string): Promise<Read> {
    // The path is sent by the SubagentStop hook: nothing that is not a transcript of this
    // worktree inside ~/.claude/projects is read, nor by following symlinks.
    const real = await realpath(path).catch(() => null);
    const base = await realpath(this.#projectsDir).catch(() => this.#projectsDir);
    if (real === null) return { jsonl: null, note: `${path} not found` };
    const project = real.startsWith(base + sep)
      ? (real.slice(base.length + 1).split(sep)[0] ?? null)
      : null;
    const own = new Set(
      [worktreePath, await realpath(worktreePath).catch(() => worktreePath)].map(projectDirName),
    );
    if (project === null || !real.endsWith(".jsonl")) {
      return { jsonl: null, note: "the transcript is outside ~/.claude/projects: not read" };
    }
    if (!own.has(project)) {
      return { jsonl: null, note: "the transcript belongs to another project: not read" };
    }
    return this.#read(real);
  }

  async #read(path: string): Promise<Read> {
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) return { jsonl: null, note: `${path} not found` };
    if (info.size > this.#maxBytes) {
      return { jsonl: null, note: `too large (${info.size} bytes): not included` };
    }
    return { jsonl: await readFile(path, "utf8") };
  }
}

export class AgentReviewerTranscriptSource implements TranscriptSource {
  readonly #claude: TranscriptSource;
  readonly #evidencePaths: Partial<Record<Exclude<AgentKind, "claude">, string>>;
  readonly #maxBytes: number;

  constructor(options: {
    claude: TranscriptSource;
    evidencePaths: Partial<Record<Exclude<AgentKind, "claude">, string>>;
    maxBytes?: number;
  }) {
    this.#claude = options.claude;
    this.#evidencePaths = options.evidencePaths;
    this.#maxBytes = options.maxBytes ?? DEFAULT_TRANSCRIPT_MAX_BYTES;
  }

  async forRun(request: TranscriptRequest): Promise<RawTranscript[]> {
    if (request.run.agentKind === "claude") return this.#claude.forRun(request);
    const kind = request.run.agentKind;
    const evidencePath = this.#evidencePaths[kind];

    const out: RawTranscript[] = [
      {
        title: `${kind === "codex" ? "Codex" : "Copilot"} CLI session`,
        jsonl: null,
        note: "LunasQ captures each reviewer's executions and answers separately",
      },
    ];
    for (const subagent of request.subagents) {
      const title = `Subagent ${subagent.agentType} (${subagent.agentId})`;
      if (!evidencePath || !subagent.agentId.startsWith(`${kind}-`) || !subagent.transcriptPath) {
        out.push({
          title,
          jsonl: null,
          note: `no transcript for a completed ${kind} execution`,
        });
        continue;
      }
      out.push({
        title,
        ...(await this.#readReviewer(
          subagent.transcriptPath,
          request.run.id,
          subagent.agentId,
          evidencePath,
          kind,
        )),
      });
    }
    return out;
  }

  async #readReviewer(
    path: string,
    runId: string,
    agentId: string,
    evidencePath: string,
    kind: Exclude<AgentKind, "claude">,
  ): Promise<Read> {
    const expectedDir = join(evidencePath, runId);
    const root = await realpath(evidencePath).catch(() => null);
    const [dirInfo, fileInfo] = await Promise.all([
      lstat(expectedDir).catch(() => null),
      lstat(path).catch(() => null),
    ]);
    const realDir = await realpath(expectedDir).catch(() => null);
    const realFile = await realpath(path).catch(() => null);
    if (
      !root ||
      !dirInfo?.isDirectory() ||
      dirInfo.isSymbolicLink() ||
      !fileInfo?.isFile() ||
      fileInfo.isSymbolicLink() ||
      realDir === null ||
      !realDir.startsWith(`${root}${sep}`) ||
      realFile === null ||
      dirname(realFile) !== realDir
    ) {
      return {
        jsonl: null,
        note: `the ${kind} transcript is outside the Run's private directory`,
      };
    }
    if (basename(realFile) !== `${agentId}.jsonl`) {
      return { jsonl: null, note: `the ${kind} transcript name does not match the reviewer` };
    }
    const info = await stat(realFile).catch(() => null);
    if (!info?.isFile()) return { jsonl: null, note: `${path} not found` };
    if (info.size > this.#maxBytes) {
      return { jsonl: null, note: `too large (${info.size} bytes): not included` };
    }
    return { jsonl: await readFile(realFile, "utf8") };
  }
}
