// Adapter de git (UW-10): lo que LunasQ lee de la rama base y el commit de los cambios que dejan
// los hooks. El resto del sistema depende solo de esta interfaz; RealGit y FakeGit cumplen la misma
// suite de contrato. Los worktrees los maneja herdr (ADR 0012).

export interface GitFile {
  /** Nombre del archivo dentro del directorio listado. */
  name: string;
  /** Modo 100755 en el commit. */
  executable: boolean;
}

export interface GitAdapter {
  /** `git fetch <remote> <branch>` en `cwd`; actualiza `<remote>/<branch>`. */
  fetch(input: { cwd: string; remote: string; branch: string }): Promise<void>;
  /** Sha del commit al que apunta `ref`; `ref_not_found` si no existe. */
  resolveCommit(input: { cwd: string; ref: string }): Promise<string>;
  /**
   * Archivos regulares directamente dentro de `dir` en el commit `commit`, sin entrar a
   * subdirectorios. Symlinks y submódulos no cuentan. Sin el directorio, `[]`. Nunca mira el
   * working tree.
   */
  listFiles(input: { cwd: string; commit: string; dir: string }): Promise<GitFile[]>;
  /** Contenido de `path` en el commit `commit`; undefined si no existe o no es un archivo. */
  readFile(input: { cwd: string; commit: string; path: string }): Promise<Buffer | undefined>;
  /** true si el working tree tiene cambios sin commit, incluidos archivos no rastreados. */
  isDirty(cwd: string): Promise<boolean>;
  /**
   * `add -A` y commit con los trailers (`Clave: valor`). Devuelve el sha, o null si no había
   * cambios: repetirlo no crea commits vacíos.
   */
  commitAll(input: {
    cwd: string;
    message: string;
    trailers: Record<string, string>;
  }): Promise<string | null>;
}
