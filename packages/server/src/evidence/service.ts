// Evidence file service (docs/design.md §Evidence file, ADR
// uw-24-archivo-evidencia). When a Run closes it gathers what the system already stores (Run, Event log,
// subagents, transcripts), converts it to markdown, redacts secrets and replaces that Run's section in
// the worktree's `lunasq/tasks/{id}.md`. The file is left uncommitted during the loop, so as not to
// move the HEAD the verification pass compares nor dirty the clean-worktree check; the
// delivery commits it with `commit`.

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { GitAdapter } from "@lunasq/adapters";
import {
  type LunasqDatabase,
  listEvents,
  RunRepository,
  RunSubagentRepository,
  TaskRepository,
  TaskWorktreeRepository,
} from "@lunasq/db";
import {
  COMMIT_TRAILER_RUN,
  COMMIT_TRAILER_TASK,
  evidencePath,
  HOOK_EXECUTED,
  HOOK_POINT_COMPLETED,
  HookExecutedPayload,
  HookPointCompletedPayload,
  TEST_GATE_EXECUTED,
  TestGateExecutedPayload,
} from "@lunasq/schemas";
import { KeyedLock } from "../worktrees/keyed-lock.ts";
import { evidenceHeader, upsertRunSection } from "./file.ts";
import { type HookLogEntry, renderRunSection, type SectionTranscript } from "./render.ts";
import { NoTranscripts, type RawTranscript, type TranscriptSource } from "./sources.ts";
import { transcriptToMarkdown } from "./transcript.ts";

export type RecordRunResult =
  | { status: "written" | "unchanged"; path: string }
  | { status: "skipped"; reason: "run_not_found" | "run_open" | "no_worktree" };

export interface EvidenceServiceDeps {
  db: LunasqDatabase;
  git: Pick<GitAdapter, "commitPaths">;
  /** Without it, the sections carry no transcripts. */
  transcripts?: TranscriptSource;
}

export class EvidenceService {
  readonly #runs: RunRepository;
  readonly #subagents: RunSubagentRepository;
  readonly #tasks: TaskRepository;
  readonly #worktrees: TaskWorktreeRepository;
  readonly #db: LunasqDatabase;
  readonly #git: Pick<GitAdapter, "commitPaths">;
  readonly #transcripts: TranscriptSource;
  /** One file per task: writes of the same task go in order. */
  readonly #locks = new KeyedLock();

  constructor(deps: EvidenceServiceDeps) {
    this.#db = deps.db;
    this.#git = deps.git;
    this.#transcripts = deps.transcripts ?? new NoTranscripts();
    this.#runs = new RunRepository(deps.db);
    this.#subagents = new RunSubagentRepository(deps.db);
    this.#tasks = new TaskRepository(deps.db);
    this.#worktrees = new TaskWorktreeRepository(deps.db);
  }

  /**
   * Rewrites the closed Run's section in its task's file. Idempotent: repeating it with
   * the same data does not change the file.
   */
  async recordRun(runId: string): Promise<RecordRunResult> {
    const first = this.#runs.get(runId);
    if (!first) return { status: "skipped", reason: "run_not_found" };
    return this.#locks.run(first.taskId, async () => {
      const run = this.#runs.get(runId);
      if (!run) return { status: "skipped", reason: "run_not_found" } as const;
      if (run.endedAt === null) return { status: "skipped", reason: "run_open" } as const;
      const worktreePath = this.#worktreePath(run.taskId);
      const task = this.#tasks.get(run.taskId);
      if (!worktreePath || !task) return { status: "skipped", reason: "no_worktree" } as const;

      const { gates, hooks } = this.#logOf(run.taskId, run.id);
      const subagents = this.#subagents.forRun(run.id);
      const raw = await this.#transcripts.forRun({ run, worktreePath, subagents });
      const section = renderRunSection({
        run,
        gates,
        hooks,
        transcripts: raw.map(toSectionTranscript),
      });

      const path = join(worktreePath, evidencePath(run.taskId));
      const current = await readFile(path, "utf8").catch(() => null);
      const header = evidenceHeader({ taskId: run.taskId, goal: task.goal });
      const next = upsertRunSection(current, header, run.id, section);
      if (next === current) return { status: "unchanged", path } as const;
      await writeAtomic(worktreePath, path, next);
      return { status: "written", path } as const;
    });
  }

  /**
   * Commits the evidence file with the task trailers and its last Run, so it travels
   * in the branch and in the PR. The rest of the worktree is not touched. Returns the sha, or null if there is no
   * file or it did not change since the last commit.
   */
  async commit(taskId: string): Promise<string | null> {
    return this.#locks.run(taskId, async () => {
      const worktreePath = this.#worktreePath(taskId);
      if (!worktreePath) return null;
      const path = evidencePath(taskId);
      if (!existsSync(join(worktreePath, path))) return null;
      const last = this.#runs.latestForTask(taskId);
      return this.#git.commitPaths({
        cwd: worktreePath,
        paths: [path],
        message: "chore(lunasq): evidence file",
        trailers: {
          [COMMIT_TRAILER_TASK]: taskId,
          ...(last && { [COMMIT_TRAILER_RUN]: last.id }),
        },
      });
    });
  }

  #worktreePath(taskId: string): string | null {
    const path = this.#worktrees.get(taskId)?.worktreePath ?? null;
    return path && existsSync(path) ? path : null;
  }

  /** Gate and hooks of the Run, in Event log order. */
  #logOf(taskId: string, runId: string) {
    const gates: TestGateExecutedPayload[] = [];
    const hooks: HookLogEntry[] = [];
    for (const event of listEvents(this.#db, taskId)) {
      if (event.type === TEST_GATE_EXECUTED) {
        const parsed = TestGateExecutedPayload.safeParse(event.payload);
        if (parsed.success && parsed.data.runId === runId) gates.push(parsed.data);
      } else if (event.type === HOOK_EXECUTED) {
        const parsed = HookExecutedPayload.safeParse(event.payload);
        if (parsed.success && parsed.data.runId === runId) {
          hooks.push({ kind: "executed", ...parsed.data });
        }
      } else if (event.type === HOOK_POINT_COMPLETED) {
        const parsed = HookPointCompletedPayload.safeParse(event.payload);
        if (parsed.success && parsed.data.runId === runId) {
          hooks.push({ kind: "point", ...parsed.data });
        }
      }
    }
    return { gates, hooks };
  }
}

function toSectionTranscript(raw: RawTranscript): SectionTranscript {
  if (raw.jsonl === null) {
    return { title: raw.title, markdown: null, ...(raw.note && { note: raw.note }) };
  }
  const markdown = transcriptToMarkdown(raw.jsonl);
  return markdown === ""
    ? { title: raw.title, markdown: null, note: "empty transcript" }
    : { title: raw.title, markdown };
}

/**
 * Writes to a temp file and renames: a cut does not leave the file half written. The worktree belongs to the
 * agent, so neither `lunasq/`, nor `lunasq/tasks/` nor the temp file can be symlinks: following them
 * would write outside the worktree.
 */
async function writeAtomic(worktreePath: string, path: string, content: string): Promise<void> {
  const dir = dirname(path);
  for (const part of [join(worktreePath, "lunasq"), dir]) {
    const info = await lstat(part).catch(() => null);
    if (info?.isSymbolicLink()) throw new Error(`${part} is a symlink: evidence is not written`);
    if (info && !info.isDirectory()) throw new Error(`${part} is not a directory`);
  }
  await mkdir(dir, { recursive: true });
  const temp = join(dir, `.${randomBytes(8).toString("hex")}.tmp`);
  try {
    // wx: fails if the name already exists, instead of writing through a planted symlink.
    await writeFile(temp, content, { encoding: "utf8", flag: "wx" });
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
