// Los 4 revisores contra Claude Code real (criterio de UW-19). No corre en `pnpm test`:
//   pnpm --filter @lunasq/server test:claude
// Levanta la app de Hono en un puerto local, copia los revisores de assets/agents al
// `.claude/agents/lunasq/` de un repo temporal y abre una sesión `claude -p` con el settings de
// hooks del dispatcher y el run token en el entorno, como en un pane. Para no gastar Opus, los
// revisores corren con `LUNASQ_REVIEWER_MODEL` (haiku por defecto); `opus` prueba los archivos tal
// cual.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { RunSubagentRepository } from "@lunasq/db";
import { insertProject, insertRun, insertTask, migratedDatabase } from "@lunasq/db/test-helpers";
import { REVIEWER_NAMES, RUN_ENV } from "@lunasq/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { ensureHookSettings } from "../dispatcher/hook-settings.ts";
import { SUBAGENT_HOOK_PATH } from "./routes.ts";

const enabled = process.env.LUNASQ_CLAUDE_INTEGRATION === "1";
const claudeBin = process.env.CLAUDE_BIN ?? "claude";
const reviewerModel = process.env.LUNASQ_REVIEWER_MODEL ?? "haiku";
const agentsDir = new URL("../../../../assets/agents/lunasq/", import.meta.url);

/** Sirve una app de Hono con node:http, sin agregar @hono/node-server. */
function serve(fetch: (req: Request) => Response | Promise<Response>): Promise<Server> {
  const server = createServer(async (req, res) => {
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : Readable.toWeb(req);
    const response = await fetch(
      new Request(`http://${req.headers.host}${req.url}`, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body: body as ReadableStream | undefined,
        duplex: "half",
      } as RequestInit),
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function runClaude(cwd: string, args: string[], env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(claudeBin, args, { cwd, env: { ...process.env, ...env } });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      out += d;
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`claude salió con ${code}:\n${out}`)),
    );
  });
}

describe.skipIf(!enabled)("revisores contra Claude Code real", { timeout: 600_000 }, () => {
  let dir: string;
  let server: Server;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "lunasq-reviewers-"));
  });

  afterAll(async () => {
    await new Promise((resolve) => server?.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });

  it("una sesión lanza los 4 revisores y LunasQ registra cada ejecución en su Run", async () => {
    const db = migratedDatabase();
    const run = insertRun(db, insertTask(db, insertProject(db).id).id, { phase: "verify" });
    server = await serve(createApp({ db }).fetch);
    const { port } = server.address() as AddressInfo;

    const repo = join(dir, "repo");
    const installed = join(repo, ".claude", "agents", "lunasq");
    mkdirSync(installed, { recursive: true });
    for (const file of readdirSync(agentsDir)) {
      const text = readFileSync(new URL(file, agentsDir), "utf8");
      writeFileSync(join(installed, file), text.replace(/^model: .*$/m, `model: ${reviewerModel}`));
    }
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base");
    writeFileSync(join(repo, "suma.js"), "export const suma = (a, b) => a + b;\n");
    git("add", "suma.js");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "AC-1: suma");

    const settings = join(dir, "settings.json");
    await ensureHookSettings(settings, `http://127.0.0.1:${port}${SUBAGENT_HOOK_PATH}`);
    const prompt = [
      `Lanza en paralelo, con la tool Agent y por nombre, estos 4 subagentes: ${REVIEWER_NAMES.join(", ")}.`,
      "A cada uno dile: «Spec: AC-1, suma(a, b) devuelve a + b. Revisa solo el diff de `git diff HEAD~1 HEAD`.»",
      "Espera los 4 reportes y responde con ellos, uno por revisor.",
    ].join(" ");
    const output = await runClaude(
      repo,
      ["-p", prompt, "--model", "haiku", "--settings", settings, "--strict-mcp-config"],
      { [RUN_ENV.runToken]: run.runToken, CLAUDE_CODE_FORK_SUBAGENT: "0" },
    );

    const recorded = new RunSubagentRepository(db).forRun(run.id);
    expect(recorded.map((r) => r.agentType).sort(), output).toEqual([...REVIEWER_NAMES].sort());
    for (const row of recorded) {
      expect(row.startedAt, row.agentType).toBeInstanceOf(Date);
      expect(row.stoppedAt, row.agentType).toBeInstanceOf(Date);
      expect(row.transcriptPath, row.agentType).toMatch(/\.jsonl$/);
    }
  });
});
