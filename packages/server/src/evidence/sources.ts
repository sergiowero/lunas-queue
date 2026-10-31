// Origen de los transcripts del archivo de evidencia (docs/design.md §Archivo de evidencia, ADR
// uw-24-archivo-evidencia). Claude Code guarda cada sesión en
// `~/.claude/projects/<cwd con no-alfanuméricos → "-">/<session-id>.jsonl` y borra los
// transcripts al vencer su retención; LunasQ los copia al cerrar el Run.
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import type { RunRow, RunSubagentRow } from "@lunasq/db";

export type TranscriptRequest = {
  run: RunRow;
  worktreePath: string;
  subagents: RunSubagentRow[];
};

/** `jsonl` es null si no se pudo leer; `note` dice por qué. */
export type RawTranscript = { title: string; jsonl: string | null; note?: string };

export interface TranscriptSource {
  /** La sesión del agente primero y después un transcript por subagente. */
  forRun(request: TranscriptRequest): Promise<RawTranscript[]>;
}

/** Sin transcripts: el archivo de evidencia queda sin esa parte. */
export class NoTranscripts implements TranscriptSource {
  async forRun(): Promise<RawTranscript[]> {
    return [];
  }
}

/** 32 MiB: un transcript más grande no cabe de forma útil en un PR. */
export const DEFAULT_TRANSCRIPT_MAX_BYTES = 32 * 1024 * 1024;

/** Nombre del directorio de proyecto que usa Claude Code para un cwd. */
export const projectDirName = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, "-");

export interface ClaudeTranscriptSourceOptions {
  /** Por defecto `~/.claude`. */
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
      const title = `Subagente ${sub.agentType} (${sub.agentId})`;
      if (!sub.transcriptPath) {
        out.push({ title, jsonl: null, note: "sin transcript: el subagente no llegó a terminar" });
        continue;
      }
      out.push({ title, ...(await this.#subagent(sub.transcriptPath, worktreePath)) });
    }
    return out;
  }

  async #session(run: RunRow, worktreePath: string): Promise<RawTranscript> {
    const title = "Sesión del agente";
    if (!run.agentSession) return { title, jsonl: null, note: "Run sin sesión de agente" };
    // Claude Code nombra el directorio con el cwd ya resuelto; el worktree puede venir por un symlink.
    const cwds = [worktreePath, await realpath(worktreePath).catch(() => worktreePath)];
    for (const cwd of new Set(cwds)) {
      const path = join(this.#projectsDir, projectDirName(cwd), `${run.agentSession}.jsonl`);
      const read = await this.#read(path);
      if (read.jsonl !== null || read.note.startsWith("demasiado grande"))
        return { title, ...read };
    }
    return {
      title,
      jsonl: null,
      note: `no se encontró el transcript de la sesión ${run.agentSession}`,
    };
  }

  async #subagent(path: string, worktreePath: string): Promise<Read> {
    // La ruta la manda el hook SubagentStop: no se lee nada que no sea un transcript de este
    // worktree dentro de ~/.claude/projects, ni siguiendo symlinks.
    const real = await realpath(path).catch(() => null);
    const base = await realpath(this.#projectsDir).catch(() => this.#projectsDir);
    if (real === null) return { jsonl: null, note: `no se encontró ${path}` };
    const project = real.startsWith(base + sep)
      ? (real.slice(base.length + 1).split(sep)[0] ?? null)
      : null;
    const own = new Set(
      [worktreePath, await realpath(worktreePath).catch(() => worktreePath)].map(projectDirName),
    );
    if (project === null || !real.endsWith(".jsonl")) {
      return { jsonl: null, note: "el transcript está fuera de ~/.claude/projects: no se lee" };
    }
    if (!own.has(project)) {
      return { jsonl: null, note: "el transcript es de otro proyecto: no se lee" };
    }
    return this.#read(real);
  }

  async #read(path: string): Promise<Read> {
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) return { jsonl: null, note: `no se encontró ${path}` };
    if (info.size > this.#maxBytes) {
      return { jsonl: null, note: `demasiado grande (${info.size} bytes): no se incluye` };
    }
    return { jsonl: await readFile(path, "utf8") };
  }
}

export class CopilotReviewerTranscriptSource implements TranscriptSource {
  readonly #claude: TranscriptSource;
  readonly #evidencePath: string;
  readonly #maxBytes: number;

  constructor(options: { claude: TranscriptSource; evidencePath: string; maxBytes?: number }) {
    this.#claude = options.claude;
    this.#evidencePath = options.evidencePath;
    this.#maxBytes = options.maxBytes ?? DEFAULT_TRANSCRIPT_MAX_BYTES;
  }

  async forRun(request: TranscriptRequest): Promise<RawTranscript[]> {
    if (request.run.agentKind !== "copilot") return this.#claude.forRun(request);

    const out: RawTranscript[] = [
      {
        title: "Sesión Copilot CLI",
        jsonl: null,
        note: "LunasQ captura por separado las ejecuciones y respuestas de cada revisor",
      },
    ];
    for (const subagent of request.subagents) {
      const title = `Subagente ${subagent.agentType} (${subagent.agentId})`;
      if (!subagent.agentId.startsWith("copilot-") || !subagent.transcriptPath) {
        out.push({
          title,
          jsonl: null,
          note: "sin transcript de una ejecución Copilot completada",
        });
        continue;
      }
      out.push({
        title,
        ...(await this.#readReviewer(subagent.transcriptPath, request.run.id, subagent.agentId)),
      });
    }
    return out;
  }

  async #readReviewer(path: string, runId: string, agentId: string): Promise<Read> {
    const expectedDir = join(this.#evidencePath, runId);
    const root = await realpath(this.#evidencePath).catch(() => null);
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
        note: "el transcript Copilot está fuera del directorio privado del Run",
      };
    }
    if (basename(realFile) !== `${agentId}.jsonl`) {
      return { jsonl: null, note: "el nombre del transcript Copilot no coincide con el revisor" };
    }
    const info = await stat(realFile).catch(() => null);
    if (!info?.isFile()) return { jsonl: null, note: `no se encontró ${path}` };
    if (info.size > this.#maxBytes) {
      return { jsonl: null, note: `demasiado grande (${info.size} bytes): no se incluye` };
    }
    return { jsonl: await readFile(realFile, "utf8") };
  }
}
