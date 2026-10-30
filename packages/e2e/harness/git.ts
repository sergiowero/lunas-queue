// git real para el repo del piloto: un origin local (bare), el checkout del proyecto y los
// worktrees de las tareas. Sin red y sin credenciales.
import { execFileSync } from "node:child_process";

const IDENTITY = {
  GIT_AUTHOR_NAME: "LunasQ e2e",
  GIT_AUTHOR_EMAIL: "e2e@lunasq.test",
  GIT_COMMITTER_NAME: "LunasQ e2e",
  GIT_COMMITTER_EMAIL: "e2e@lunasq.test",
};

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      ...IDENTITY,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
