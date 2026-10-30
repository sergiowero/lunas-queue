// Servicio del archivo de evidencia (docs/design.md §Archivo de evidencia, ADR
// uw-24-archivo-evidencia). Al cerrar un Run reúne lo que el sistema ya guarda (Run, Event log,
// subagentes, transcripts), lo convierte a markdown, redacta secretos y reemplaza la sección de ese
// Run en `lunasq/tasks/{id}.md` del worktree. El archivo queda sin commitear durante el loop, para no
// mover el HEAD que compara el pass de la verificación ni ensuciar el chequeo de worktree limpio; la
// entrega lo commitea con `commit`.

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
  /** Sin él, las secciones no llevan transcripts. */
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
  /** Un archivo por tarea: las escrituras de una misma tarea van en orden. */
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
   * Reescribe la sección del Run cerrado en el archivo de su tarea. Idempotente: repetirlo con
   * los mismos datos no cambia el archivo.
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
      const header = evidenceHeader({ taskId: run.taskId, intent: task.intent });
      const next = upsertRunSection(current, header, run.id, section);
      if (next === current) return { status: "unchanged", path } as const;
      await writeAtomic(worktreePath, path, next);
      return { status: "written", path } as const;
    });
  }

  /**
   * Commitea el archivo de evidencia con los trailers de la tarea y su último Run, para que viaje
   * en el branch y en el PR. Lo demás del worktree no se toca. Devuelve el sha, o null si no hay
   * archivo o no cambió desde el último commit.
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
        message: "chore(lunasq): archivo de evidencia",
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

  /** Gate y hooks del Run, en el orden del Event log. */
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
    ? { title: raw.title, markdown: null, note: "transcript vacío" }
    : { title: raw.title, markdown };
}

/**
 * Escribe a un temporal y renombra: un corte no deja el archivo a medias. El worktree es del
 * agente, así que ni `lunasq/`, ni `lunasq/tasks/` ni el temporal pueden ser symlinks: seguirlos
 * escribiría fuera del worktree.
 */
async function writeAtomic(worktreePath: string, path: string, content: string): Promise<void> {
  const dir = dirname(path);
  for (const part of [join(worktreePath, "lunasq"), dir]) {
    const info = await lstat(part).catch(() => null);
    if (info?.isSymbolicLink()) throw new Error(`${part} es un symlink: no se escribe evidencia`);
    if (info && !info.isDirectory()) throw new Error(`${part} no es un directorio`);
  }
  await mkdir(dir, { recursive: true });
  const temp = join(dir, `.${randomBytes(8).toString("hex")}.tmp`);
  try {
    // wx: falla si el nombre ya existe, en vez de escribir a través de un symlink plantado.
    await writeFile(temp, content, { encoding: "utf8", flag: "wx" });
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
