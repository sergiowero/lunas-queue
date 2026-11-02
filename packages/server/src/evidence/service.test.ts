import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RealGit } from "@lunasq/adapters";
import {
  appendEvent,
  closeRun,
  type LunasqDatabase,
  RunRepository,
  RunSubagentRepository,
  TaskWorktreeRepository,
} from "@lunasq/db";
import { insertProject, insertRun, insertTask, migratedDatabase } from "@lunasq/db/test-helpers";
import {
  evidencePath,
  HOOK_EXECUTED,
  HOOK_POINT_COMPLETED,
  TEST_GATE_EXECUTED,
} from "@lunasq/schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EvidenceService } from "./service.ts";
import type { RawTranscript, TranscriptRequest, TranscriptSource } from "./sources.ts";

const sha = "a".repeat(40);

class FakeTranscripts implements TranscriptSource {
  readonly requests: TranscriptRequest[] = [];
  result: RawTranscript[] = [];
  async forRun(request: TranscriptRequest) {
    this.requests.push(request);
    return this.result;
  }
}

const dirs: string[] = [];
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function worktree(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lunasq-evidence-")));
  dirs.push(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "README.md"), "repo\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

let db: LunasqDatabase;
let transcripts: FakeTranscripts;
let service: EvidenceService;
let wt: string;
let taskId: string;

beforeEach(() => {
  db = migratedDatabase();
  transcripts = new FakeTranscripts();
  service = new EvidenceService({ db, git: new RealGit(), transcripts });
  wt = worktree();
  const project = insertProject(db);
  taskId = insertTask(db, project.id, { intent: "Agregar login" }).id;
  new TaskWorktreeRepository(db).recordWorktree(taskId, { branch: "uw-01", worktreePath: wt });
});

const file = () => join(wt, evidencePath(taskId));

function closedRun(over: Parameters<typeof insertRun>[2] = {}, result = "success" as const) {
  const run = insertRun(db, taskId, over);
  closeRun(db, run.id, { result });
  return run;
}

describe("EvidenceService.recordRun", () => {
  it("writes lunasq/tasks/{id}.md with the Run's section on close", async () => {
    const run = closedRun({ phase: "implement" });
    const res = await service.recordRun(run.id);
    expect(res).toEqual({ status: "written", path: file() });
    const md = readFileSync(file(), "utf8");
    expect(md).toContain(`# Evidence for task ${taskId}`);
    expect(md).toContain("Agregar login");
    expect(md).toContain(`## Run ${run.id} · implement`);
  });

  it("adds a section for each Run, in close order", async () => {
    const first = closedRun({ phase: "implement" });
    const second = closedRun({ phase: "verify" });
    await service.recordRun(first.id);
    await service.recordRun(second.id);
    const md = readFileSync(file(), "utf8");
    expect(md.indexOf(`## Run ${first.id}`)).toBeLessThan(md.indexOf(`## Run ${second.id}`));
  });

  it("repeating the close of the same Run leaves the file equal", async () => {
    const run = closedRun();
    await service.recordRun(run.id);
    const before = readFileSync(file(), "utf8");
    expect(await service.recordRun(run.id)).toEqual({ status: "unchanged", path: file() });
    expect(readFileSync(file(), "utf8")).toBe(before);
  });

  it("records failure_reason, handoff, gate output and hooks of the Run", async () => {
    const run = insertRun(db, taskId, { phase: "implement" });
    closeRun(db, run.id, {
      result: "failure",
      failureReason: "test_gate_failed: 2 rojos",
      handoff: { schemaVersion: 1, phase: "implementation", marker: "HANDOFF-X" },
    });
    appendEvent(db, {
      taskId,
      type: TEST_GATE_EXECUTED,
      actor: "system",
      payload: {
        runId: run.id,
        trigger: "submit_for_verification",
        command: "pnpm test",
        headSha: sha,
        exitCode: 1,
        timedOut: false,
        durationMs: 900,
        passed: false,
        output: "GATE-OUTPUT-ROJO\n",
        error: null,
      },
    });
    appendEvent(db, {
      taskId,
      type: HOOK_EXECUTED,
      actor: "system",
      payload: {
        point: "after_implementation",
        script: "10-bump",
        baseRef: sha,
        runId: run.id,
        policy: "warn",
        timeoutSeconds: 60,
        exitCode: 0,
        timedOut: false,
        durationMs: 10,
        passed: true,
        output: "HOOK-OUTPUT\n",
      },
    });
    appendEvent(db, {
      taskId,
      type: HOOK_POINT_COMPLETED,
      actor: "system",
      payload: {
        point: "after_implementation",
        baseRef: sha,
        runId: run.id,
        outcome: "passed",
        failedScript: null,
        error: null,
        commit: null,
        commitSkipped: false,
      },
    });
    await service.recordRun(run.id);
    const md = readFileSync(file(), "utf8");
    expect(md).toContain("test_gate_failed: 2 rojos");
    expect(md).toContain("HANDOFF-X");
    expect(md).toContain("GATE-OUTPUT-ROJO");
    expect(md).toContain("HOOK-OUTPUT");
    expect(md).toContain("result: passed");
  });

  it("does not mix the events of other Runs or other tasks", async () => {
    const mine = closedRun();
    const other = closedRun();
    const gate = (runId: string, output: string) => ({
      runId,
      trigger: "submit_for_verification",
      command: "pnpm test",
      headSha: sha,
      exitCode: 0,
      timedOut: false,
      durationMs: 1,
      passed: true,
      output,
      error: null,
    });
    appendEvent(db, {
      taskId,
      type: TEST_GATE_EXECUTED,
      actor: "system",
      payload: gate(other.id, "DE-OTRO-RUN"),
    });
    appendEvent(db, {
      taskId,
      type: TEST_GATE_EXECUTED,
      actor: "system",
      payload: gate(mine.id, "DE-ESTE-RUN"),
    });
    await service.recordRun(mine.id);
    const md = readFileSync(file(), "utf8");
    expect(md).toContain("DE-ESTE-RUN");
    expect(md).not.toContain("DE-OTRO-RUN");
  });

  it("converts to markdown the transcript of the session and the subagents", async () => {
    const run = closedRun({ phase: "verify", agentSession: "sess-9" });
    new RunSubagentRepository(db).recordStop(run.id, {
      agentId: "ag-1",
      agentType: "lunasq-code-reviewer",
      transcriptPath: "/x/agent-1.jsonl",
    });
    transcripts.result = [
      {
        title: "Sesión del agente",
        jsonl: JSON.stringify({ type: "user", message: { role: "user", content: "hola agente" } }),
      },
      { title: "Subagent lunasq-code-reviewer (ag-1)", jsonl: null, note: "not found" },
    ];
    await service.recordRun(run.id);
    expect(transcripts.requests[0]?.worktreePath).toBe(wt);
    expect(transcripts.requests[0]?.subagents.map((s) => s.agentId)).toEqual(["ag-1"]);
    const md = readFileSync(file(), "utf8");
    expect(md).toContain("hola agente");
    expect(md).toContain("<summary>Subagent lunasq-code-reviewer (ag-1)</summary>");
    expect(md).toContain("not found");
  });

  it("redacts secrets before writing", async () => {
    const run = closedRun();
    const token = `ghp_${"a1B2c3D4e5".repeat(4)}`;
    transcripts.result = [
      {
        title: "Sesión del agente",
        jsonl: JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: `usé ${token}` }] },
        }),
      },
    ];
    await service.recordRun(run.id);
    const md = readFileSync(file(), "utf8");
    expect(md).not.toContain(token);
    expect(md).toContain("[REDACTED");
  });

  it("leaves no temporary files next to the evidence one", async () => {
    await service.recordRun(closedRun().id);
    expect(readdirSync(join(wt, "lunasq/tasks"))).toEqual([`${taskId}.md`]);
  });

  it("writes nothing for a Run that is still open", async () => {
    const run = insertRun(db, taskId);
    expect(await service.recordRun(run.id)).toEqual({ status: "skipped", reason: "run_open" });
    expect(existsSync(file())).toBe(false);
  });

  it("writes nothing if the Run does not exist or the task no longer has a worktree", async () => {
    expect(await service.recordRun("no-existe")).toEqual({
      status: "skipped",
      reason: "run_not_found",
    });
    const run = closedRun();
    new TaskWorktreeRepository(db).clearWorktreePath(taskId);
    expect(await service.recordRun(run.id)).toEqual({ status: "skipped", reason: "no_worktree" });
    new TaskWorktreeRepository(db).recordWorktree(taskId, {
      branch: "uw-01",
      worktreePath: join(wt, "borrado"),
    });
    expect(await service.recordRun(run.id)).toEqual({ status: "skipped", reason: "no_worktree" });
  });

  it("does not write through a symlink in lunasq/ or in lunasq/tasks", async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "lunasq-outside-")));
    dirs.push(outside);
    symlinkSync(outside, join(wt, "lunasq"));
    const run = closedRun();
    await expect(service.recordRun(run.id)).rejects.toThrow(/symlink/);
    expect(readdirSync(outside)).toEqual([]);

    rmSync(join(wt, "lunasq"));
    mkdirSync(join(wt, "lunasq"));
    symlinkSync(outside, join(wt, "lunasq/tasks"));
    await expect(service.recordRun(run.id)).rejects.toThrow(/symlink/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("concurrent closes of several Runs do not lose sections", async () => {
    const runs = [closedRun(), closedRun(), closedRun(), closedRun()];
    await Promise.all(runs.map((r) => service.recordRun(r.id)));
    const md = readFileSync(file(), "utf8");
    for (const r of runs) expect(md).toContain(`## Run ${r.id}`);
  });

  it("leaves the file uncommitted and the worktree clean for the UW-15/23 checks", async () => {
    await service.recordRun(closedRun().id);
    expect(git(wt, "status", "--porcelain", "--untracked-files=all")).toContain("lunasq/tasks/");
    expect(await new RealGit().isDirty(wt)).toBe(false);
  });
});

describe("EvidenceService.commit", () => {
  it("commits only the evidence file, with the task trailers and the last Run", async () => {
    const run = closedRun();
    await service.recordRun(run.id);
    writeFileSync(join(wt, "ajeno.txt"), "cambio del agente");

    const commit = await service.commit(taskId);
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    expect(git(wt, "rev-parse", "HEAD")).toBe(commit);
    expect(git(wt, "show", "--name-only", "--format=", "HEAD")).toBe(evidencePath(taskId));
    const message = git(wt, "log", "-1", "--format=%B");
    expect(message).toContain(`LunasQ-Task: ${taskId}`);
    expect(message).toContain(`LunasQ-Run: ${run.id}`);
    expect(git(wt, "status", "--porcelain")).toBe("?? ajeno.txt");
  });

  it("travels in the branch: the file is in HEAD's tree", async () => {
    await service.recordRun(closedRun().id);
    await service.commit(taskId);
    expect(git(wt, "ls-tree", "-r", "--name-only", "HEAD")).toContain(evidencePath(taskId));
  });

  it("a new section after the commit is committed as a separate change", async () => {
    await service.recordRun(closedRun().id);
    const first = await service.commit(taskId);
    expect(await service.commit(taskId)).toBeNull();
    await service.recordRun(closedRun({ phase: "verify" }).id);
    expect(await new RealGit().isDirty(wt)).toBe(false);
    const second = await service.commit(taskId);
    expect(second).not.toBe(first);
    expect(readFileSync(file(), "utf8").match(/^## Run /gm)).toHaveLength(2);
  });

  it("is null if there is no file or worktree", async () => {
    expect(await service.commit(taskId)).toBeNull();
    new TaskWorktreeRepository(db).clearWorktreePath(taskId);
    expect(await service.commit(taskId)).toBeNull();
  });

  it("also works if the project ignores lunasq/tasks/ in its .gitignore", async () => {
    writeFileSync(join(wt, ".gitignore"), "lunasq/tasks/\n");
    git(wt, "add", ".gitignore");
    git(wt, "commit", "-q", "-m", "ignore");
    await service.recordRun(closedRun().id);
    expect(await service.commit(taskId)).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("RunRepository without changes", () => {
  it("the service only reads: it does not modify the Run", async () => {
    const run = closedRun();
    const before = new RunRepository(db).get(run.id);
    await service.recordRun(run.id);
    expect(new RunRepository(db).get(run.id)).toEqual(before);
  });
});
