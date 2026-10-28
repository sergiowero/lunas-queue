// Suite de contrato contra herdr real (>= 0.9.5). No corre en `pnpm test`:
//   pnpm --filter @lunasq/adapters test:herdr
// Levanta un servidor headless en una sesión propia (`lunasq-contract-<pid>`), nunca la del
// usuario, y la borra al terminar. En vez de Claude Code usa un `claude` stub que se reporta a
// herdr con `pane report-agent`; el stub entra al PATH del pane por `ZDOTDIR` (requiere zsh).
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe } from "vitest";
import { herdrContract } from "./contract.ts";
import { defaultSocketPath, RealHerdr } from "./real.ts";

const enabled = process.env.LUNASQ_HERDR_INTEGRATION === "1";
const herdrBin = process.env.HERDR_BIN ?? "herdr";

const STUB_AGENT = `#!/bin/sh
# Agente stub: se reporta idle y trata cada línea de entrada como un prompt.
r() { "$HERDR_BIN_PATH" pane report-agent "$HERDR_PANE_ID" --source lunasq-stub --agent claude --state "$1" >/dev/null 2>&1; }
echo "stub claude $*"
r idle
while IFS= read -r line; do r working; echo "got: $line"; sleep 1; r idle; done
`;

async function waitFor(check: () => boolean, what: string, timeoutMs = 10_000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timeout esperando ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe.skipIf(!enabled)("herdr real", () => {
  herdrContract(
    "herdr real",
    async () => {
      const session = `lunasq-contract-${process.pid}`;
      const dir = realpathSync(mkdtempSync(join(tmpdir(), "lunasq-herdr-")));
      const bin = join(dir, "bin");
      const zdot = join(dir, "zdot");
      mkdirSync(bin);
      mkdirSync(zdot);
      writeFileSync(join(bin, "claude"), STUB_AGENT);
      chmodSync(join(bin, "claude"), 0o755);
      writeFileSync(join(zdot, ".zshrc"), 'export PATH="$LUNASQ_STUB_BIN:$PATH"\nPS1="$ "\n');

      const server = spawn(herdrBin, ["--session", session, "server"], {
        detached: true,
        stdio: "ignore",
      });
      server.unref();
      const socketPath = defaultSocketPath(session);
      await waitFor(() => existsSync(socketPath), `el socket de ${session}`);

      const adapter = new RealHerdr({
        bin: herdrBin,
        session,
        socketPath,
        backoff: { initialMs: 50, maxMs: 500 },
      });
      let repos = 0;
      const herdr = (...args: string[]) =>
        execFileSync(herdrBin, ["--session", session, ...args], { stdio: "ignore" });

      return {
        adapter,
        newRepo: async () => {
          const repo = join(dir, `repo${++repos}`);
          mkdirSync(repo);
          const git = (...args: string[]) =>
            execFileSync("git", args, { cwd: repo, stdio: "ignore" });
          git("init", "-q", "-b", "main");
          git(
            "-c",
            "user.name=lunasq",
            "-c",
            "user.email=lunasq@localhost",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "init",
          );
          return repo;
        },
        worktreePath: (name) => join(dir, "worktrees", name),
        agentKind: "claude",
        agentEnv: { ZDOTDIR: zdot, LUNASQ_STUB_BIN: bin },
        dropStreams: () => adapter.dropStreams(),
        cleanup: async () => {
          try {
            herdr("server", "stop");
            herdr("session", "delete", session);
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        },
      };
    },
    { timeoutMs: 20_000 },
  );
});
