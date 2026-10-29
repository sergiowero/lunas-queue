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
  describe(`contrato del adapter de git: ${name}`, () => {
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

        await git.fetch({ cwd, remote: "origin", branch: "main" });
        const after = await git.resolveCommit({ cwd, ref: "origin/main" });
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
    });
  });
}
