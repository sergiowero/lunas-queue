// Fake en memoria del adapter de git. Cada checkout (cwd) tiene sus refs y un working tree que
// solo sabe si está sucio; los commits son árboles inmutables. Cumple la suite de contrato.
import { createHash } from "node:crypto";
import { EVIDENCE_DIR } from "@lunasq/schemas";
import { GitError } from "./errors.ts";
import type { GitAdapter, GitFile } from "./types.ts";

export type FakeTree = Record<string, { content: string | Buffer; executable?: boolean }>;

interface FakeFile {
  content: Buffer;
  executable: boolean;
}

interface FakeCommit {
  sha: string;
  tree: Map<string, FakeFile>;
  message: string;
}

interface FakeCheckout {
  refs: Map<string, string>;
  /** Ramas del remoto (`origin`), que `fetch` copia a `<remote>/<rama>`. */
  remote: Map<string, string>;
  /** Rutas con cambios sin commit; `setDirty` usa una ruta genérica. */
  dirty: Set<string>;
}

const GENERIC_CHANGE = "(cambios)";
const isEvidence = (path: string) => path.startsWith(`${EVIDENCE_DIR}/`);

export class FakeGit implements GitAdapter {
  private readonly checkouts = new Map<string, FakeCheckout>();
  private readonly commits = new Map<string, FakeCommit>();
  private seq = 0;

  /** Commits hechos con commitAll, para que los tests los inspeccionen. */
  readonly commitLog: {
    cwd: string;
    sha: string;
    message: string;
    trailers: Record<string, string>;
  }[] = [];

  /** Crea el checkout `cwd` con `remote/branch` (y HEAD) apuntando a un commit con `tree`. */
  addCheckout(cwd: string, opts: { remote?: string; branch: string; tree: FakeTree }) {
    const remote = opts.remote ?? "origin";
    const sha = this.commit(opts.tree, "init");
    const checkout: FakeCheckout = {
      refs: new Map([
        [`${remote}/${opts.branch}`, sha],
        ["HEAD", sha],
      ]),
      remote: new Map([[opts.branch, sha]]),
      dirty: new Set(),
    };
    this.checkouts.set(cwd, checkout);
    return sha;
  }

  /** Un commit nuevo en la rama del remoto; el checkout lo ve después de `fetch`. */
  pushToRemote(cwd: string, branch: string, tree: FakeTree) {
    const sha = this.commit(tree, "push");
    this.checkout(cwd).remote.set(branch, sha);
    return sha;
  }

  /** Simula cambios sin commit en el working tree (un hook que escribe archivos). */
  setDirty(cwd: string, dirty = true) {
    const checkout = this.checkout(cwd);
    if (dirty) checkout.dirty.add(GENERIC_CHANGE);
    else checkout.dirty.clear();
  }

  /** Escribe `path` en el working tree sin commitear. */
  writeWorkingFile(cwd: string, path: string) {
    this.checkout(cwd).dirty.add(path);
  }

  /** Rutas del árbol de HEAD. */
  trackedFiles(cwd: string): string[] {
    const head = this.commits.get(this.checkout(cwd).refs.get("HEAD") ?? "");
    return [...(head?.tree.keys() ?? [])];
  }

  async fetch(input: { cwd: string; remote: string; branch: string }) {
    const checkout = this.checkout(input.cwd);
    const sha = checkout.remote.get(input.branch);
    if (!sha) {
      throw new GitError("git_failed", `couldn't find remote ref ${input.branch}`);
    }
    checkout.refs.set(`${input.remote}/${input.branch}`, sha);
    return sha;
  }

  async resolveCommit(input: { cwd: string; ref: string }) {
    const checkout = this.checkout(input.cwd);
    const sha = checkout.refs.get(input.ref) ?? (this.commits.has(input.ref) ? input.ref : null);
    if (!sha) throw new GitError("ref_not_found", `${input.ref} en ${input.cwd}`);
    return sha;
  }

  async listFiles(input: { cwd: string; commit: string; dir: string }): Promise<GitFile[]> {
    const prefix = `${input.dir.replace(/\/+$/, "")}/`;
    const files: GitFile[] = [];
    for (const [path, file] of this.requireCommit(input.cwd, input.commit).tree) {
      const name = path.slice(prefix.length);
      if (path.startsWith(prefix) && !name.includes("/")) {
        files.push({ name, executable: file.executable });
      }
    }
    return files;
  }

  async readFile(input: { cwd: string; commit: string; path: string }) {
    const file = this.requireCommit(input.cwd, input.commit).tree.get(input.path);
    return file ? Buffer.from(file.content) : undefined;
  }

  async isDirty(cwd: string) {
    return [...this.checkout(cwd).dirty].some((path) => !isEvidence(path));
  }

  async commitAll(input: { cwd: string; message: string; trailers: Record<string, string> }) {
    const checkout = this.checkout(input.cwd);
    const paths = [...checkout.dirty].filter((path) => !isEvidence(path));
    if (paths.length === 0) return null;
    return this.commitDirty(input, paths);
  }

  async commitPaths(input: {
    cwd: string;
    paths: string[];
    message: string;
    trailers: Record<string, string>;
  }) {
    const checkout = this.checkout(input.cwd);
    const paths = input.paths.filter((path) => checkout.dirty.has(path));
    if (paths.length === 0) return null;
    return this.commitDirty(input, paths);
  }

  private commitDirty(
    input: { cwd: string; message: string; trailers: Record<string, string> },
    paths: string[],
  ) {
    const checkout = this.checkout(input.cwd);
    const parent = this.commits.get(checkout.refs.get("HEAD") ?? "");
    const trailers = Object.entries(input.trailers).map(([k, v]) => `${k}: ${v}`);
    const message = trailers.length
      ? `${input.message}\n\n${trailers.join("\n")}\n`
      : `${input.message}\n`;
    const tree = new Map(parent?.tree);
    for (const path of paths) {
      checkout.dirty.delete(path);
      if (path !== GENERIC_CHANGE) tree.set(path, { content: Buffer.alloc(0), executable: false });
    }
    const sha = this.store(tree, message);
    checkout.refs.set("HEAD", sha);
    this.commitLog.push({ cwd: input.cwd, sha, message: input.message, trailers: input.trailers });
    return sha;
  }

  async addDetachedWorktree(input: { cwd: string; path: string; commit: string }) {
    this.requireCommit(input.cwd, input.commit);
    if (this.checkouts.has(input.path)) throw new GitError("git_failed", `${input.path} ya existe`);
    this.checkouts.set(input.path, {
      refs: new Map([["HEAD", input.commit]]),
      remote: new Map(),
      dirty: new Set(),
    });
  }

  async removeWorktree(input: { cwd: string; path: string }) {
    this.checkout(input.cwd);
    this.checkouts.delete(input.path);
  }

  /** true si `path` es un checkout conocido (p. ej. un worktree temporal que no se borró). */
  hasCheckout(path: string) {
    return this.checkouts.has(path);
  }

  /** Mensaje del commit en HEAD de `cwd`. */
  headMessage(cwd: string) {
    return this.commits.get(this.checkout(cwd).refs.get("HEAD") ?? "")?.message ?? "";
  }

  private commit(tree: FakeTree, message: string) {
    const files = new Map<string, FakeFile>();
    for (const [path, f] of Object.entries(tree)) {
      files.set(path, { content: Buffer.from(f.content), executable: f.executable ?? false });
    }
    return this.store(files, message);
  }

  private store(tree: Map<string, FakeFile>, message: string) {
    const sha = createHash("sha1")
      .update(`fake-commit-${++this.seq}`)
      .digest("hex");
    this.commits.set(sha, { sha, tree, message });
    return sha;
  }

  private checkout(cwd: string) {
    const checkout = this.checkouts.get(cwd);
    if (!checkout) throw new GitError("git_unavailable", `no existe ${cwd}`);
    return checkout;
  }

  private requireCommit(cwd: string, sha: string) {
    this.checkout(cwd);
    const commit = this.commits.get(sha);
    if (!commit) throw new GitError("git_failed", `${sha} no es un commit`);
    return commit;
  }
}
