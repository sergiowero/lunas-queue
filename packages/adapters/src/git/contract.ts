// Suite de contrato del adapter de git: corre contra el fake y contra git real (ambas en
// `pnpm test`; git real solo necesita repos temporales).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isGitError } from "./errors.ts";
import type { GitAdapter } from "./types.ts";

export type RepoFiles = Record<string, { content: string; executable?: boolean }>;

export interface GitContractHarness {
  adapter: GitAdapter;
  /** Un checkout con remoto `origin` cuya rama `main` tiene `files`, ya traída. */
  newRepo(files: RepoFiles): Promise<string>;
  /** Un commit nuevo en `main` del remoto con `files` (reemplaza el árbol); el checkout no lo trae. */
  pushToRemote(cwd: string, files: RepoFiles): Promise<void>;
  /** Escribe en el working tree del checkout sin commitear. */
  writeWorkingFile(cwd: string, path: string, content: string): Promise<void>;
  /** Rutas rastreadas en HEAD. */
  trackedFiles(cwd: string): Promise<string[]>;
  /** Una ruta que todavía no existe, para un worktree temporal. */
  freePath(): Promise<string>;
  /** Crea la rama local `branch` en HEAD y se pasa a ella. */
  checkoutBranch(cwd: string, branch: string): Promise<void>;
  /** Sha de `branch` en el remoto `origin`; null si no existe. */
  remoteBranch(cwd: string, branch: string): Promise<string | null>;
  /** Mensaje completo del commit en HEAD. */
  headMessage(cwd: string): Promise<string>;
  cleanup(): Promise<void>;
}

const hooks: RepoFiles = {
  "README.md": { content: "repo\n" },
  "lunasq/hooks/config": { content: "{}\n" },
  "lunasq/hooks/before_delivery/10-bump": { content: "#!/bin/sh\necho bump\n", executable: true },
  "lunasq/hooks/before_delivery/notes.txt": { content: "no es hook\n" },
  "lunasq/hooks/before_delivery/sub/20-nested": { content: "#!/bin/sh\n", executable: true },
};

export function gitContract(name: string, setup: () => Promise<GitContractHarness>): void {
  // Cada prueba arma repos y remotos reales; bajo la carga del gate superan los 5s por defecto.
  describe(`contrato del adapter de git: ${name}`, { timeout: 30_000 }, () => {
    let h: GitContractHarness;
    let git: GitAdapter;

    beforeAll(async () => {
      h = await setup();
      git = h.adapter;
    });

    afterAll(async () => {
      await h?.cleanup();
    });

    describe("rama base", () => {
      it("fetch trae el commit nuevo del remoto y resolveCommit da su sha", async () => {
        const cwd = await h.newRepo(hooks);
        const before = await git.resolveCommit({ cwd, ref: "origin/main" });
        expect(before).toMatch(/^[0-9a-f]{40}$/);

        await h.pushToRemote(cwd, { ...hooks, "CHANGELOG.md": { content: "v2\n" } });
        expect(await git.resolveCommit({ cwd, ref: "origin/main" })).toBe(before);

        const fetched = await git.fetch({ cwd, remote: "origin", branch: "main" });
        const after = await git.resolveCommit({ cwd, ref: "origin/main" });
        expect(fetched).toBe(after);
        expect(after).toMatch(/^[0-9a-f]{40}$/);
        expect(after).not.toBe(before);
      });

      it("fetch de un branch inexistente y resolveCommit de un ref inexistente fallan", async () => {
        const cwd = await h.newRepo(hooks);
        await expect(git.fetch({ cwd, remote: "origin", branch: "no-existe" })).rejects.toSatisfy(
          (err) => isGitError(err, "git_failed"),
        );
        await expect(git.resolveCommit({ cwd, ref: "origin/no-existe" })).rejects.toSatisfy((err) =>
          isGitError(err, "ref_not_found"),
        );
      });

      it("listFiles da los archivos directos del directorio con su bit de ejecución", async () => {
        const cwd = await h.newRepo(hooks);
        const commit = await git.resolveCommit({ cwd, ref: "origin/main" });
        const files = await git.listFiles({ cwd, commit, dir: "lunasq/hooks/before_delivery" });
        expect(files.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
          { name: "10-bump", executable: true },
          { name: "notes.txt", executable: false },
        ]);
        expect(await git.listFiles({ cwd, commit, dir: "lunasq/hooks/after_merge" })).toEqual([]);
      });

      it("readFile lee el commit; undefined si no existe o es un directorio", async () => {
        const cwd = await h.newRepo(hooks);
        const commit = await git.resolveCommit({ cwd, ref: "origin/main" });
        const content = await git.readFile({
          cwd,
          commit,
          path: "lunasq/hooks/before_delivery/10-bump",
        });
        expect(content?.toString("utf8")).toBe("#!/bin/sh\necho bump\n");
        expect(await git.readFile({ cwd, commit, path: "lunasq/hooks/nada" })).toBeUndefined();
        expect(await git.readFile({ cwd, commit, path: "lunasq/hooks" })).toBeUndefined();
      });

      it("los cambios del working tree no se ven en el commit", async () => {
        const cwd = await h.newRepo(hooks);
        const commit = await git.resolveCommit({ cwd, ref: "origin/main" });
        await h.writeWorkingFile(cwd, "lunasq/hooks/before_delivery/10-bump", "rm -rf /\n");
        await h.writeWorkingFile(cwd, "lunasq/hooks/before_delivery/05-evil", "rm -rf /\n");

        const files = await git.listFiles({ cwd, commit, dir: "lunasq/hooks/before_delivery" });
        expect(files.map((f) => f.name)).not.toContain("05-evil");
        const content = await git.readFile({
          cwd,
          commit,
          path: "lunasq/hooks/before_delivery/10-bump",
        });
        expect(content?.toString("utf8")).toBe("#!/bin/sh\necho bump\n");
      });
    });

    describe("worktrees temporales", () => {
      it("addDetachedWorktree abre el commit en otra ruta y removeWorktree lo borra", async () => {
        const cwd = await h.newRepo(hooks);
        const commit = await git.resolveCommit({ cwd, ref: "origin/main" });
        const path = await h.freePath();

        await git.addDetachedWorktree({ cwd, path, commit });
        expect(await git.resolveCommit({ cwd: path, ref: "HEAD" })).toBe(commit);
        expect(await git.isDirty(path)).toBe(false);

        await git.removeWorktree({ cwd, path });
        await git.removeWorktree({ cwd, path });
        await expect(git.isDirty(path)).rejects.toSatisfy((err) =>
          isGitError(err, "git_unavailable"),
        );
      });
    });

    describe("commit de cambios", () => {
      it("isDirty ve archivos nuevos y modificados", async () => {
        const cwd = await h.newRepo(hooks);
        expect(await git.isDirty(cwd)).toBe(false);
        await h.writeWorkingFile(cwd, "VERSION", "1.0.1\n");
        expect(await git.isDirty(cwd)).toBe(true);
      });

      it("commitAll commitea todo con los trailers y no crea commits vacíos", async () => {
        const cwd = await h.newRepo(hooks);
        expect(
          await git.commitAll({ cwd, message: "nada", trailers: { "LunasQ-Task": "t1" } }),
        ).toBeNull();

        await h.writeWorkingFile(cwd, "VERSION", "1.0.1\n");
        const sha = await git.commitAll({
          cwd,
          message: "chore(lunasq): hooks before_delivery",
          trailers: { "LunasQ-Task": "t1", "LunasQ-Run": "r1" },
        });
        expect(sha).toMatch(/^[0-9a-f]{40}$/);
        expect(sha).toBe(await git.resolveCommit({ cwd, ref: "HEAD" }));
        expect(await git.isDirty(cwd)).toBe(false);

        const message = await h.headMessage(cwd);
        expect(message).toMatch(/^chore\(lunasq\): hooks before_delivery\n/);
        expect(message).toMatch(/\n\nLunasQ-Task: t1\nLunasQ-Run: r1\n*$/);

        expect(await git.commitAll({ cwd, message: "otra", trailers: {} })).toBeNull();
      });

      it("isDirty y commitAll ignoran lunasq/tasks/, que es de LunasQ", async () => {
        const cwd = await h.newRepo(hooks);
        await h.writeWorkingFile(cwd, "lunasq/tasks/t1.md", "# evidencia\n");
        expect(await git.isDirty(cwd)).toBe(false);
        expect(
          await git.commitAll({ cwd, message: "nada", trailers: { "LunasQ-Task": "t1" } }),
        ).toBeNull();

        // Un cambio del agente sí cuenta, y su commit no arrastra la evidencia.
        await h.writeWorkingFile(cwd, "VERSION", "1.0.1\n");
        expect(await git.isDirty(cwd)).toBe(true);
        const before = await git.resolveCommit({ cwd, ref: "HEAD" });
        const sha = await git.commitAll({ cwd, message: "cambio", trailers: {} });
        expect(sha).not.toBe(before);
        expect(await git.isDirty(cwd)).toBe(false);
        expect(await h.trackedFiles(cwd)).not.toContain("lunasq/tasks/t1.md");
      });
    });

    describe("integración con la rama base", () => {
      const commit = async (cwd: string, path: string, content: string, message: string) => {
        await h.writeWorkingFile(cwd, path, content);
        const sha = await git.commitAll({ cwd, message, trailers: {} });
        if (!sha) throw new Error("el commit del test no creó nada");
        return sha;
      };

      it("rebase sin novedades en la base no toca la rama", async () => {
        const cwd = await h.newRepo(hooks);
        await h.checkoutBranch(cwd, "lunasq/t1");
        const mine = await commit(cwd, "VERSION", "1\n", "feat: version");
        expect(await git.rebase({ cwd, onto: "origin/main" })).toEqual({
          status: "up_to_date",
          head: mine,
        });
      });

      it("rebase pone los commits de la rama sobre la base nueva", async () => {
        const cwd = await h.newRepo(hooks);
        await h.checkoutBranch(cwd, "lunasq/t1");
        await commit(cwd, "VERSION", "1\n", "feat: version");
        await h.pushToRemote(cwd, { ...hooks, "CHANGELOG.md": { content: "v2\n" } });
        await git.fetch({ cwd, remote: "origin", branch: "main" });

        const result = await git.rebase({ cwd, onto: "origin/main" });
        expect(result.status).toBe("rebased");
        if (result.status !== "rebased") return;
        expect(result.head).toBe(await git.resolveCommit({ cwd, ref: "HEAD" }));
        expect(await h.trackedFiles(cwd)).toEqual(
          expect.arrayContaining(["VERSION", "CHANGELOG.md"]),
        );
        expect(await git.isDirty(cwd)).toBe(false);
        // Ya integrada, repetirlo no hace nada.
        expect((await git.rebase({ cwd, onto: "origin/main" })).status).toBe("up_to_date");
      });

      it("rebase con un conflicto lo aborta y deja el worktree como estaba", async () => {
        const cwd = await h.newRepo(hooks);
        await h.checkoutBranch(cwd, "lunasq/t1");
        const mine = await commit(cwd, "README.md", "mi cambio\n", "feat: readme");
        await h.pushToRemote(cwd, { ...hooks, "README.md": { content: "su cambio\n" } });
        await git.fetch({ cwd, remote: "origin", branch: "main" });

        expect(await git.rebase({ cwd, onto: "origin/main" })).toEqual({
          status: "conflict",
          files: ["README.md"],
        });
        expect(await git.resolveCommit({ cwd, ref: "HEAD" })).toBe(mine);
        expect(await git.isDirty(cwd)).toBe(false);
      });

      it("rebase con el worktree sucio falla sin tocar nada", async () => {
        const cwd = await h.newRepo(hooks);
        await h.checkoutBranch(cwd, "lunasq/t1");
        await commit(cwd, "VERSION", "1\n", "feat: version");
        await h.pushToRemote(cwd, { ...hooks, "CHANGELOG.md": { content: "v2\n" } });
        await git.fetch({ cwd, remote: "origin", branch: "main" });
        await h.writeWorkingFile(cwd, "VERSION", "2\n");

        await expect(git.rebase({ cwd, onto: "origin/main" })).rejects.toSatisfy((err) =>
          isGitError(err, "git_failed"),
        );
      });

      it("listCommits da los commits de base..HEAD del más viejo al más nuevo", async () => {
        const cwd = await h.newRepo(hooks);
        const base = await git.resolveCommit({ cwd, ref: "origin/main" });
        await h.checkoutBranch(cwd, "lunasq/t1");
        expect(await git.listCommits({ cwd, base })).toEqual([]);
        const first = await commit(cwd, "a.txt", "a\n", "feat: a\n\ncuerpo");
        const second = await commit(cwd, "b.txt", "b\n", "feat: b");

        const commits = await git.listCommits({ cwd, base });
        expect(commits.map((c) => c.sha)).toEqual([first, second]);
        expect(commits.map((c) => c.subject)).toEqual(["feat: a", "feat: b"]);
        expect(commits[0]?.message).toMatch(/^feat: a\n\ncuerpo/);
        expect(commits[0]?.authoredAt).toBeInstanceOf(Date);
        expect(Number.isNaN(commits[0]?.authoredAt.getTime())).toBe(false);
      });

      it("addTrailers reescribe los commits indicados y repetirlo no cambia nada", async () => {
        const cwd = await h.newRepo(hooks);
        const base = await git.resolveCommit({ cwd, ref: "origin/main" });
        await h.checkoutBranch(cwd, "lunasq/t1");
        const first = await commit(cwd, "a.txt", "a\n", "feat(x): a");
        const second = await commit(cwd, "b.txt", "b\n", "feat: b");

        const head = await git.addTrailers({
          cwd,
          base,
          trailers: { [first]: { "LunasQ-Task": "t1", "LunasQ-Run": "r1" } },
        });
        expect(head).toBe(await git.resolveCommit({ cwd, ref: "HEAD" }));
        expect(head).not.toBe(second);
        expect(await git.isDirty(cwd)).toBe(false);
        expect(await h.trackedFiles(cwd)).toEqual(expect.arrayContaining(["a.txt", "b.txt"]));

        const commits = await git.listCommits({ cwd, base });
        expect(commits.map((c) => c.subject)).toEqual(["feat(x): a", "feat: b"]);
        expect(commits[0]?.message).toMatch(/^feat\(x\): a\n\nLunasQ-Task: t1\nLunasQ-Run: r1\n*$/);
        expect(commits[1]?.message).not.toContain("LunasQ-");

        // Segunda vez: los shas son otros, pero las claves ya están y no se agrega nada.
        const [rewritten] = commits;
        const again = await git.addTrailers({
          cwd,
          base,
          trailers: { [rewritten?.sha ?? ""]: { "LunasQ-Task": "t1", "LunasQ-Run": "r2" } },
        });
        expect(again).toBe(head);
      });

      it("push publica el HEAD en la rama del remoto y se repite tras reescribir la historia", async () => {
        const cwd = await h.newRepo(hooks);
        const base = await git.resolveCommit({ cwd, ref: "origin/main" });
        await h.checkoutBranch(cwd, "lunasq/t1");
        const mine = await commit(cwd, "a.txt", "a\n", "feat: a");
        expect(await h.remoteBranch(cwd, "lunasq/t1")).toBeNull();

        await git.push({ cwd, remote: "origin", branch: "lunasq/t1" });
        expect(await h.remoteBranch(cwd, "lunasq/t1")).toBe(mine);
        // Mismo HEAD: no falla.
        await git.push({ cwd, remote: "origin", branch: "lunasq/t1" });

        const head = await git.addTrailers({
          cwd,
          base,
          trailers: { [mine]: { "LunasQ-Task": "t1" } },
        });
        await git.push({ cwd, remote: "origin", branch: "lunasq/t1" });
        expect(await h.remoteBranch(cwd, "lunasq/t1")).toBe(head);
      });

      it("push a un remoto que no existe falla con git_failed", async () => {
        const cwd = await h.newRepo(hooks);
        await h.checkoutBranch(cwd, "lunasq/t1");
        await expect(git.push({ cwd, remote: "no-existe", branch: "lunasq/t1" })).rejects.toSatisfy(
          (err) => isGitError(err, "git_failed"),
        );
      });
    });

    describe("commitPaths", () => {
      it("commitea solo esas rutas con los trailers y no crea commits vacíos", async () => {
        const cwd = await h.newRepo(hooks);
        await h.writeWorkingFile(cwd, "lunasq/tasks/t1.md", "# evidencia\n");
        await h.writeWorkingFile(cwd, "VERSION", "1.0.1\n");

        const sha = await git.commitPaths({
          cwd,
          paths: ["lunasq/tasks/t1.md"],
          message: "chore(lunasq): evidencia",
          trailers: { "LunasQ-Task": "t1", "LunasQ-Run": "r1" },
        });
        expect(sha).toMatch(/^[0-9a-f]{40}$/);
        expect(sha).toBe(await git.resolveCommit({ cwd, ref: "HEAD" }));
        expect(await h.trackedFiles(cwd)).toContain("lunasq/tasks/t1.md");
        expect(await h.trackedFiles(cwd)).not.toContain("VERSION");
        // El cambio ajeno sigue sin commitear.
        expect(await git.isDirty(cwd)).toBe(true);

        const message = await h.headMessage(cwd);
        expect(message).toMatch(/^chore\(lunasq\): evidencia\n/);
        expect(message).toMatch(/\n\nLunasQ-Task: t1\nLunasQ-Run: r1\n*$/);

        expect(
          await git.commitPaths({
            cwd,
            paths: ["lunasq/tasks/t1.md"],
            message: "otra",
            trailers: {},
          }),
        ).toBeNull();
      });

      it("commitea una nueva versión del archivo ya rastreado", async () => {
        const cwd = await h.newRepo(hooks);
        const input = { cwd, paths: ["lunasq/tasks/t1.md"], message: "evidencia", trailers: {} };
        await h.writeWorkingFile(cwd, "lunasq/tasks/t1.md", "uno\n");
        const first = await git.commitPaths(input);
        await h.writeWorkingFile(cwd, "lunasq/tasks/t1.md", "uno\ndos\n");
        const second = await git.commitPaths(input);
        expect(second).not.toBe(first);
        expect(second).toBe(await git.resolveCommit({ cwd, ref: "HEAD" }));
      });
    });
  });
}
