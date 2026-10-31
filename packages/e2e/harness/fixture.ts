// El repo del proyecto piloto: un origin bare, el checkout local con la base `main` y los hooks por
// fase en `lunasq/hooks` (ADR uw-10-hooks). Un hook por política: `before_verification` pasa y
// `after_implementation` falla con `warn`, así la vista de hooks muestra los dos resultados.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { git } from "./git.ts";

export interface Fixture {
  /** Repo remoto (bare); el `merge` de la entrega lo avanza directamente. */
  origin: string;
  /** Checkout del proyecto: su `localPath`. */
  repo: string;
  /** Dónde viven los worktrees de las tareas. */
  worktrees: string;
}

const FILES: Record<string, { content: string; executable?: true }> = {
  "README.md": { content: "# Piloto de LunasQ\n" },
  "test.sh": {
    // La suite del proyecto: pasa mientras ningún archivo de `work/` esté vacío.
    content:
      '#!/bin/sh\nfor f in work/*; do [ -s "$f" ] || { echo "vacío: $f"; exit 1; }; done\necho "suite en verde"\n',
    executable: true,
  },
  "work/.gitkeep": { content: "x\n" },
  "lunasq/hooks/config": {
    content: `${JSON.stringify({ after_implementation: { "10-lint.sh": { policy: "warn" } } }, null, 2)}\n`,
  },
  "lunasq/hooks/before_verification/10-prepare.sh": {
    content: '#!/bin/sh\necho "preparando $LUNASQ_TASK_ID en $LUNASQ_BRANCH"\n',
    executable: true,
  },
  "lunasq/hooks/after_implementation/10-lint.sh": {
    content: '#!/bin/sh\necho "lint: 1 aviso en work/"\nexit 1\n',
    executable: true,
  },
  "lunasq/hooks/after_merge/10-announce.sh": {
    content: '#!/bin/sh\necho "mergeado $LUNASQ_PR_URL"\n',
    executable: true,
  },
};

export function createFixture(root: string): Fixture {
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  const worktrees = join(root, "worktrees");
  mkdirSync(worktrees, { recursive: true });
  git(root, "init", "--bare", "--initial-branch=main", origin);
  git(root, "clone", "--quiet", origin, repo);
  git(repo, "checkout", "-B", "main");
  for (const [path, file] of Object.entries(FILES)) {
    const full = join(repo, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, file.content);
    if (file.executable) chmodSync(full, 0o755);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "--quiet", "-m", "chore: repo del piloto");
  git(repo, "push", "--quiet", "origin", "main");
  return { origin, repo, worktrees };
}

/**
 * Avanza `main` del origin hasta `branch`, como lo haría el merge de un PR sin conflictos. Exige
 * que la rama ya descienda de `main` (la entrega la rebasa): un PR que no lo cumple no es
 * mergeable y el piloto lo reporta como fallo.
 */
export function mergeIntoMain(fixture: Fixture, branch: string): void {
  try {
    git(fixture.origin, "merge-base", "--is-ancestor", "refs/heads/main", `refs/heads/${branch}`);
  } catch (error) {
    if (error instanceof Error && "status" in error && error.status === 1) {
      throw new Error(`${branch} no es un avance directo de main: el PR no es mergeable`);
    }
    throw error;
  }
  git(fixture.origin, "update-ref", "refs/heads/main", `refs/heads/${branch}`);
}
