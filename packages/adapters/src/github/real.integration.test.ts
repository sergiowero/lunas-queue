// Suite de contrato contra GitHub real. No corre en `pnpm test`:
//   LUNASQ_GH_SANDBOX_REPO=<owner>/<repo> pnpm --filter @lunasq/adapters test:gh
// Necesita `gh` autenticado y un repo sandbox desechable: clona el repo en un directorio
// temporal, publica branches `lunasq-contract/*` con commits vacíos, abre PRs, mergea algunos
// hacia la rama por defecto y borra los branches al terminar.
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe } from "vitest";
import { gitHubContract } from "./contract.ts";
import { RealGitHub } from "./real.ts";

const enabled = process.env.LUNASQ_GH_INTEGRATION === "1";
const repo = process.env.LUNASQ_GH_SANDBOX_REPO ?? "";

describe.skipIf(!enabled)("GitHub real", () => {
  gitHubContract(
    "gh real",
    async () => {
      if (!repo) throw new Error("falta LUNASQ_GH_SANDBOX_REPO=<owner>/<repo>");
      const dir = realpathSync(mkdtempSync(join(tmpdir(), "lunasq-gh-")));
      const cwd = join(dir, "repo");
      const run = (file: string, args: string[]) =>
        execFileSync(file, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      execFileSync("gh", ["repo", "clone", repo, cwd, "--", "--quiet"], { stdio: "ignore" });
      const base = run("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
        .trim()
        .replace(/^origin\//, "");
      const pushed: string[] = [];
      let seq = 0;

      return {
        adapter: new RealGitHub(),
        newBranch: async () => {
          const head = `lunasq-contract/${process.pid}-${Date.now().toString(36)}-${++seq}`;
          run("git", ["checkout", "--quiet", "-B", head, `origin/${base}`]);
          run("git", ["commit", "--quiet", "--allow-empty", "-m", `contrato ${head}`]);
          run("git", ["push", "--quiet", "origin", head]);
          pushed.push(head);
          return { cwd, head, base };
        },
        merge: async (url) => {
          run("gh", ["pr", "merge", url, "--merge"]);
        },
        close: async (url) => {
          run("gh", ["pr", "close", url]);
        },
        missingUrl: `https://github.com/${repo}/pull/999999`,
        cleanup: async () => {
          for (const head of pushed) {
            try {
              run("git", ["push", "--quiet", "origin", "--delete", head]);
            } catch {
              // Ya borrado (p. ej. por la configuración del repo al mergear).
            }
          }
          rmSync(dir, { recursive: true, force: true });
        },
      };
    },
    { timeoutMs: 60_000 },
  );
});
