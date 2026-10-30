// Runner que ejecuta comandos de proyecto en un pane de herdr (docs/tech-stack.md: hooks y gate de
// tests se ven en herdr como cualquier agente). `pane run` no informa el exit code, así que el
// comando corre dentro de un wrapper que copia la salida a un log y deja el exit code en un
// archivo; el runner espera ese archivo. Cumple la misma interfaz que ShellProcessRunner.
import { existsSync } from "node:fs";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HerdrAdapter } from "../herdr/types.ts";
import { OUTPUT_LIMIT_BYTES } from "./real.ts";
import type { ProcessInput, ProcessResult, ProcessRunner } from "./types.ts";

/** Exit code con que se informa un timeout: el del SIGKILL, como ShellProcessRunner. */
export const PANE_TIMEOUT_EXIT_CODE = 137;
/** Exit code si el pane se cerró (otro proceso o el usuario) antes de que el comando terminara. */
export const PANE_CLOSED_EXIT_CODE = 129;

export interface HerdrPaneRunnerOptions {
  herdr: HerdrAdapter;
  /** Pane del que se abre uno nuevo por ejecución, p. ej. el raíz del worktree de la tarea. */
  parentPaneId: string;
  /** Dónde van el wrapper, el log y el exit code de cada ejecución; por defecto, el tmpdir. */
  stateDir?: string;
  pollMs?: number;
  /** Cada cuánto se confirma con herdr que el pane sigue abierto. */
  paneCheckMs?: number;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Comilla simple para sh. */
const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * Con allowlist, `cmd.sh` corre con `env -i` y solo las variables de la allowlist que el pane
 * tenga definidas, más las de `env`. Los nombres ya están validados como nombres de shell.
 */
const launch = (input: ProcessInput) => {
  if (input.envAllowlist === undefined) return `/bin/sh "$d/cmd.sh"`;
  const names = [...new Set([...input.envAllowlist, ...Object.keys(input.env ?? {})])];
  return [
    "set --",
    ...names.map((n) => `[ -n "\${${n}+x}" ] && set -- "$@" "${n}=$${n}"`),
    `env -i "$@" /bin/sh "$d/cmd.sh"`,
  ].join("\n");
};

/**
 * Corre `cmd.sh` con /bin/sh, muestra su salida en el pane y la copia a `out.log`; el exit code
 * se escribe al final con un rename, así nunca se lee a medias. El cwd y el env se vuelven a fijar
 * aquí porque los rc del shell del pane pueden cambiarlos, y stdin es /dev/null para que un
 * comando que lee la terminal no se quede esperando.
 */
const wrapper = (dir: string, input: ProcessInput) => `#!/bin/sh
d=${shellQuote(dir)}
cd ${shellQuote(input.cwd)} || { echo 1 > "$d/exit"; exit 1; }
${Object.entries(input.env ?? {})
  .map(([k, v]) => `export ${k}=${shellQuote(v)}`)
  .join("\n")}
{ ${launch(input)} </dev/null; echo $? > "$d/exit.tmp"; } 2>&1 | tee "$d/out.log"
mv "$d/exit.tmp" "$d/exit"
`;

export class HerdrPaneRunner implements ProcessRunner {
  private readonly herdr: HerdrAdapter;
  private readonly parentPaneId: string;
  private readonly stateDir: string;
  private readonly pollMs: number;
  private readonly paneCheckMs: number;

  constructor(opts: HerdrPaneRunnerOptions) {
    this.herdr = opts.herdr;
    this.parentPaneId = opts.parentPaneId;
    this.stateDir = opts.stateDir ?? tmpdir();
    this.pollMs = opts.pollMs ?? 100;
    this.paneCheckMs = opts.paneCheckMs ?? 2_000;
  }

  /**
   * El env se fija en el pane (`pane split --env`), que hereda el del servidor de herdr, no el de
   * LunasQ. Lanza si herdr no puede abrir el pane.
   */
  async run(input: ProcessInput): Promise<ProcessResult> {
    const badName = [...Object.keys(input.env ?? {}), ...(input.envAllowlist ?? [])].find(
      (name) => !ENV_NAME.test(name),
    );
    if (badName !== undefined) throw new Error(`nombre de variable inválido: ${badName}`);
    const dir = await mkdtemp(join(this.stateDir, "lunasq-pane-"));
    try {
      await writeFile(join(dir, "cmd.sh"), input.command);
      await writeFile(join(dir, "run.sh"), wrapper(dir, input));
      const pane = await this.herdr.splitPane({
        paneId: this.parentPaneId,
        cwd: input.cwd,
        env: input.env ?? {},
      });
      try {
        await this.herdr.runInPane({
          paneId: pane.paneId,
          command: `/bin/sh ${shellQuote(join(dir, "run.sh"))}`,
        });
        const end = await this.waitForExit(dir, pane.paneId, input.timeoutMs);
        const output = await tail(join(dir, "out.log"));
        if (end === "timeout") {
          return { exitCode: PANE_TIMEOUT_EXIT_CODE, stdout: output, stderr: "", timedOut: true };
        }
        if (end === "pane_closed") {
          const stderr = "el pane se cerró antes de que el comando terminara";
          return { exitCode: PANE_CLOSED_EXIT_CODE, stdout: output, stderr, timedOut: false };
        }
        return { exitCode: end, stdout: output, stderr: "", timedOut: false };
      } finally {
        // Cerrar el pane mata lo que siga corriendo (timeout o hijos en background).
        await this.herdr.closePane(pane.paneId);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async waitForExit(
    dir: string,
    paneId: string,
    timeoutMs: number | undefined,
  ): Promise<number | "timeout" | "pane_closed"> {
    const exitFile = join(dir, "exit");
    const started = Date.now();
    let lastCheck = started;
    for (;;) {
      if (existsSync(exitFile)) {
        const code = Number.parseInt((await readFile(exitFile, "utf8")).trim(), 10);
        return Number.isNaN(code) ? 1 : code;
      }
      const now = Date.now();
      if (timeoutMs !== undefined && now - started >= timeoutMs) return "timeout";
      if (now - lastCheck >= this.paneCheckMs) {
        lastCheck = now;
        const { panes } = await this.herdr.snapshot();
        // Se vuelve a mirar el archivo: el comando pudo terminar justo antes de cerrarse el pane.
        if (!panes.some((p) => p.paneId === paneId) && !existsSync(exitFile)) return "pane_closed";
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
    }
  }
}

/** Los últimos OUTPUT_LIMIT_BYTES del archivo; vacío si no existe. */
async function tail(path: string): Promise<string> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(path, "r");
    const { size } = await file.stat();
    const length = Math.min(size, OUTPUT_LIMIT_BYTES);
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } catch {
    return "";
  } finally {
    await file?.close();
  }
}
