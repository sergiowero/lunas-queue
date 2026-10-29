// Despacho de punta a punta contra herdr real (>= 0.9.5). No corre en `pnpm test`:
//   pnpm --filter @lunasq/server test:herdr
// Como la suite de contrato de UW-02: servidor headless en una sesión propia y un `claude` stub
// que entra al PATH del pane por `ZDOTDIR` (requiere zsh). El stub muestra el diálogo de confianza
// de carpeta de Claude Code y se queda bloqueado hasta recibir teclas, así se prueba que el
// dispatcher lo acepta. Registra sus args y su run token para comprobarlos.
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSocketPath, RealHerdr, ShellProcessRunner } from "@lunasq/adapters";
import { ProjectRepository, RunRepository } from "@lunasq/db";
import { insertTask, migratedDatabase } from "@lunasq/db/test-helpers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Orchestrator } from "./orchestrator.ts";

const enabled = process.env.LUNASQ_HERDR_INTEGRATION === "1";
const herdrBin = process.env.HERDR_BIN ?? "herdr";

const STUB_AGENT = `#!/bin/sh
r() { "$HERDR_BIN_PATH" pane report-agent "$HERDR_PANE_ID" --source lunasq-stub --agent claude --state "$1" >/dev/null 2>&1; }
printf '%s\\n' "$*" > "$LUNASQ_STUB_OUT/$LUNASQ_RUN_ID.args"
printf '%s' "$LUNASQ_RUN_TOKEN" > "$LUNASQ_STUB_OUT/$LUNASQ_RUN_ID.token"
echo " Quick safety check: Is this a project you created or one you trust?"
echo " ❯ No, exit"
echo "   Yes, I trust this folder"
echo " Enter to confirm · Esc to cancel"
r blocked
IFS= read -r keys
printf '%s' "$keys" > "$LUNASQ_STUB_OUT/$LUNASQ_RUN_ID.keys"
clear
r idle
while IFS= read -r line; do r working; echo "got: $line"; sleep 1; r idle; done
`;

async function waitFor(check: () => boolean, what: string, timeoutMs = 15_000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timeout esperando ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe.skipIf(!enabled)("dispatcher contra herdr real", { timeout: 60_000 }, () => {
  const session = `lunasq-dispatch-${process.pid}`;
  let dir: string;
  let herdr: RealHerdr;
  const run = (bin: string, args: string[], cwd?: string) =>
    execFileSync(bin, args, { cwd, stdio: "ignore" });

  beforeAll(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "lunasq-dispatch-")));
    for (const sub of ["bin", "zdot", "out"]) mkdirSync(join(dir, sub));
    writeFileSync(join(dir, "bin", "claude"), STUB_AGENT);
    chmodSync(join(dir, "bin", "claude"), 0o755);
    writeFileSync(join(dir, "zdot", ".zshrc"), 'export PATH="$LUNASQ_STUB_BIN:$PATH"\nPS1="$ "\n');

    // Repo con origin: el worktree sale de origin/main tras un fetch (ADR 0012).
    const origin = join(dir, "origin.git");
    run("git", ["init", "-q", "--bare", "-b", "main", origin]);
    const seed = join(dir, "seed");
    run("git", ["clone", "-q", origin, seed]);
    run(
      "git",
      [
        "-c",
        "user.name=lunasq",
        "-c",
        "user.email=lunasq@localhost",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "init",
      ],
      seed,
    );
    run("git", ["push", "-q", "origin", "HEAD:main"], seed);
    run("git", ["clone", "-q", origin, join(dir, "repo")]);

    const server = spawn(herdrBin, ["--session", session, "server"], {
      detached: true,
      stdio: "ignore",
    });
    server.unref();
    const socketPath = defaultSocketPath(session);
    await waitFor(() => existsSync(socketPath), `el socket de ${session}`);
    herdr = new RealHerdr({ bin: herdrBin, session, socketPath });
  }, 30_000);

  afterAll(() => {
    try {
      run(herdrBin, ["--session", session, "server", "stop"]);
      run(herdrBin, ["--session", session, "session", "delete", session]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("despacha una fase de punta a punta, acepta la confianza y no duplica al repetir", async () => {
    const db = migratedDatabase();
    const project = new ProjectRepository(db).create({
      name: `dispatch-${process.pid}`,
      repo: "lunasq/toy",
      baseBranch: "main",
      localPath: join(dir, "repo"),
      agentProfiles: {
        refine: { kind: "claude", model: "haiku", args: ["--permission-mode", "auto"] },
      },
    });
    const task = insertTask(db, project.id);
    const out = join(dir, "out");
    const orchestrator = new Orchestrator({
      db,
      herdr,
      processes: new ShellProcessRunner(),
      mcp: { configPath: join(dir, "mcp.json"), url: "http://127.0.0.1:4518/mcp" },
      config: { tickIntervalMs: 60_000 },
      paneEnv: {
        ZDOTDIR: join(dir, "zdot"),
        LUNASQ_STUB_BIN: join(dir, "bin"),
        LUNASQ_STUB_OUT: out,
      },
    });

    try {
      await orchestrator.start();
      await orchestrator.dispatcher.idle();

      const runs = new RunRepository(db);
      const [row] = runs.forTask(task.id);
      if (!row?.herdrName) throw new Error("sin Run lanzado");
      expect(row.launchedAt).toBeInstanceOf(Date);
      expect(row.result).toBeNull();

      // Args y env llegaron al proceso del agente.
      const args = readFileSync(join(out, `${row.id}.args`), "utf8");
      expect(args).toContain("--model haiku --permission-mode auto");
      expect(args).toContain(`--mcp-config ${join(dir, "mcp.json")} --strict-mcp-config`);
      expect(args).toContain(`--session-id ${row.agentSession}`);
      expect(readFileSync(join(out, `${row.id}.token`), "utf8")).toBe(row.runToken);
      expect(existsSync(join(out, `${row.id}.keys`))).toBe(true);

      // El prompt de fase llegó y la metadata quedó en el sidebar.
      const name = row.herdrName;
      await herdr.waitAgent({ name, until: ["idle", "done"], timeoutMs: 10_000 });
      expect(await herdr.readAgent({ name, lines: 40 })).toContain("got: Usa la skill refine-task");
      const agent = await herdr.getAgent(name);
      expect(agent?.tokens).toMatchObject({ task: task.id, phase: "refine", run: row.id });

      // Repetir: otra pasada y otro recover no abren agentes.
      await orchestrator.scheduler.run();
      await orchestrator.dispatcher.recover();
      await orchestrator.dispatcher.idle();
      const agents = (await herdr.snapshot()).agents.filter((a) => a.tokens.task === task.id);
      expect(agents).toHaveLength(1);

      // Cierre de fase: el pane se cierra con su agente.
      await orchestrator.dispatcher.closeRun(row.id, { result: "success" });
      expect(await herdr.getAgent(name)).toBeUndefined();
      expect(runs.get(row.id)?.result).toBe("success");
    } finally {
      await orchestrator.stop();
    }
  });
});
