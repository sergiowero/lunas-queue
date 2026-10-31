// PaneTestGate con git real y FakeHerdr, que ejecuta de verdad lo que recibe el pane: la suite
// corre en el worktree y su resultado queda en el Event log.
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeHerdr, HerdrPaneRunner, type ProcessRunner, RealGit } from "@lunasq/adapters";
import { listEvents } from "@lunasq/db";
import { insertProject, insertTask, migratedDatabase } from "@lunasq/db/test-helpers";
import { TEST_GATE_EXECUTED, TEST_GATE_OUTPUT_LIMIT } from "@lunasq/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GATE_TIMEOUT_MS, GATE_OUTPUT_LIMIT } from "../mcp/ports.ts";
import { GATE_ENV_ALLOWLIST, PaneTestGate, UnavailableTestGate } from "./gate.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

function repo() {
  const dir = tempDir("lunasq-gate-wt-");
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir })
      .toString()
      .trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "repo\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return { dir, head: git("rev-parse", "HEAD") };
}

async function setup(opts: { runner?: ProcessRunner; timeoutMs?: number } = {}) {
  const db = migratedDatabase();
  const project = insertProject(db);
  const task = insertTask(db, project.id);
  const wt = repo();
  const herdr = new FakeHerdr();
  const { workspace, rootPaneId } = await herdr.ensureWorkspace({ cwd: wt.dir, label: "wt" });
  const worktrees = {
    ensure: vi.fn(async () => ({
      branch: "lunasq/t",
      path: wt.dir,
      workspaceId: workspace.workspaceId,
      rootPaneId,
      created: false,
    })),
  };
  const panes: string[] = [];
  const stateDir = tempDir("lunasq-gate-state-");
  const gate = new PaneTestGate({
    db,
    git: new RealGit(),
    worktrees,
    runnerFor: (paneId) => {
      panes.push(paneId);
      return (
        opts.runner ??
        new HerdrPaneRunner({ herdr, parentPaneId: paneId, stateDir, pollMs: 10, paneCheckMs: 50 })
      );
    },
    ...(opts.timeoutMs !== undefined && { timeoutMs: opts.timeoutMs }),
  });
  const input = (command: string | null) => ({
    taskId: task.id,
    runId: "run-1",
    worktreePath: wt.dir,
    command,
    trigger: "submit_for_verification" as const,
  });
  const events = () =>
    listEvents(db, task.id)
      .filter((e) => e.type === TEST_GATE_EXECUTED)
      .map((e) => e.payload as Record<string, unknown>);
  return { db, task, wt, herdr, rootPaneId, worktrees, panes, gate, input, events };
}

describe("PaneTestGate", () => {
  it("una suite en rojo no pasa y su salida y exit code quedan en el Event log", async () => {
    const { gate, input, events, wt, panes, rootPaneId } = await setup();
    const result = await gate.run(input("echo '1 failed'; exit 1"));
    expect(result).toEqual({ passed: false, output: "1 failed\n" });
    expect(panes).toEqual([rootPaneId]);
    expect(events()).toEqual([
      {
        runId: "run-1",
        trigger: "submit_for_verification",
        command: "echo '1 failed'; exit 1",
        headSha: wt.head,
        exitCode: 1,
        timedOut: false,
        durationMs: expect.any(Number),
        passed: false,
        output: "1 failed\n",
        error: null,
      },
    ]);
  });

  it("una suite en verde pasa, corre en el worktree y registra el disparo", async () => {
    const { gate, input, events, wt } = await setup();
    const result = await gate.run({ ...input("pwd; echo ok"), trigger: "verdict_pass" });
    expect(result).toEqual({ passed: true, output: `${wt.dir}\nok\n` });
    expect(events()).toMatchObject([{ trigger: "verdict_pass", exitCode: 0, passed: true }]);
  });

  it("la suite no ve credenciales del entorno y corre en modo CI con el contexto de la tarea", async () => {
    process.env.GH_TOKEN = "secreto";
    try {
      const { gate, input, task } = await setup();
      const result = await gate.run(
        input(
          `printf '%s|%s|%s|%s|%s' "\${GH_TOKEN-}" "$CI" "$LUNASQ_TASK_ID" "$LUNASQ_RUN_ID" "\${HOME:+home}"`,
        ),
      );
      expect(result.output).toBe(`|1|${task.id}|run-1|home`);
    } finally {
      delete process.env.GH_TOKEN;
    }
  });

  it("pasa la allowlist mínima y el timeout al runner", async () => {
    const calls: Parameters<ProcessRunner["run"]>[0][] = [];
    const runner: ProcessRunner = {
      run: async (i) => {
        calls.push(i);
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
      },
    };
    const { gate, input, wt } = await setup({ runner });
    await gate.run(input("pnpm test"));
    expect(calls).toEqual([
      {
        command: "pnpm test",
        cwd: wt.dir,
        env: expect.objectContaining({ CI: "1" }),
        envAllowlist: GATE_ENV_ALLOWLIST,
        timeoutMs: DEFAULT_GATE_TIMEOUT_MS,
      },
    ]);
    expect(GATE_ENV_ALLOWLIST).toContain("PATH");
    expect(GATE_ENV_ALLOWLIST).not.toContain("GH_TOKEN");
  });

  it("sin comando de tests no pasa, no abre pane y queda registrado", async () => {
    const { gate, input, events, panes } = await setup();
    const result = await gate.run(input(null));
    expect(result.passed).toBe(false);
    expect(result.output).toMatch(/no tiene comando de tests/);
    expect(panes).toEqual([]);
    expect(events()).toMatchObject([
      { command: null, exitCode: null, passed: false, error: expect.stringMatching(/comando/) },
    ]);
  });

  it("un comando vacío cuenta como sin comando y queda registrado", async () => {
    const { gate, input, events, panes } = await setup();
    expect((await gate.run(input("  "))).passed).toBe(false);
    expect(panes).toEqual([]);
    expect(events()).toMatchObject([{ command: null, passed: false }]);
  });

  it("si el worktree asegurado no es el del Run, falla cerrado sin correr la suite", async () => {
    const { gate, input, events, panes } = await setup();
    const result = await gate.run({ ...input("true"), worktreePath: "/otro/worktree" });
    expect(result.passed).toBe(false);
    expect(panes).toEqual([]);
    expect(events()).toMatchObject([{ passed: false, error: expect.stringMatching(/otro/) }]);
  });

  it("una suite que excede el tiempo límite no pasa", async () => {
    const { gate, input, events } = await setup({ timeoutMs: 1500 });
    const result = await gate.run(input("echo empieza; sleep 5"));
    expect(result.passed).toBe(false);
    expect(result.output).toMatch(/empieza[\s\S]*tiempo límite/);
    expect(events()).toMatchObject([{ timedOut: true, passed: false }]);
  });

  it("si herdr no puede abrir el pane, falla cerrado y lo registra", async () => {
    const runner: ProcessRunner = {
      run: async () => {
        throw new Error("herdr no responde");
      },
    };
    const { gate, input, events } = await setup({ runner });
    const result = await gate.run(input("pnpm test"));
    expect(result.passed).toBe(false);
    expect(result.output).toMatch(/herdr no responde/);
    expect(events()).toMatchObject([
      { exitCode: null, passed: false, error: expect.stringMatching(/herdr no responde/) },
    ]);
  });

  it("si no se puede asegurar el worktree, falla cerrado y lo registra", async () => {
    const { gate, input, events, worktrees } = await setup();
    worktrees.ensure.mockRejectedValueOnce(new Error("sin workspace"));
    const result = await gate.run(input("pnpm test"));
    expect(result.passed).toBe(false);
    expect(events()).toMatchObject([
      { passed: false, error: expect.stringMatching(/sin workspace/) },
    ]);
  });

  it("recorta la salida: el agente recibe el final y el evento hasta 16 KiB", async () => {
    const { gate, input, events } = await setup();
    const result = await gate.run(input("yes linea | head -c 40000; echo; echo FIN; exit 2"));
    expect(result.output.length).toBeLessThanOrEqual(GATE_OUTPUT_LIMIT);
    expect(result.output).toMatch(/FIN\n$/);
    const [event] = events();
    expect(String(event?.output).length).toBeLessThanOrEqual(TEST_GATE_OUTPUT_LIMIT);
    expect(event?.output).toMatch(/FIN\n$/);
  });
});

describe("UnavailableTestGate", () => {
  it("nunca pasa: un servidor sin herdr no acepta verificaciones", async () => {
    const result = await new UnavailableTestGate().run({
      taskId: "t",
      runId: "r",
      worktreePath: "/wt",
      command: "pnpm test",
      trigger: "submit_for_verification",
    });
    expect(result.passed).toBe(false);
  });
});
