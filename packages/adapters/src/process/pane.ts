// Runner that executes project commands in a herdr pane (docs/tech-stack.md: hooks and test
// gate show up in herdr like any agent). `pane run` does not report the exit code, so the
// command runs inside a wrapper that copies the output to a log and leaves the exit code in a
// file; the runner waits for that file. It meets the same interface as ShellProcessRunner.
import { existsSync } from "node:fs";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HerdrAdapter } from "../herdr/types.ts";
import { OUTPUT_LIMIT_BYTES } from "./real.ts";
import type { ProcessInput, ProcessResult, ProcessRunner } from "./types.ts";

/** Exit code used to report a timeout: the SIGKILL one, like ShellProcessRunner. */
export const PANE_TIMEOUT_EXIT_CODE = 137;
/** Exit code if the pane was closed (by another process or the user) before the command finished. */
export const PANE_CLOSED_EXIT_CODE = 129;

export interface HerdrPaneRunnerOptions {
  herdr: HerdrAdapter;
  /** Pane from which a new one is opened per execution, e.g. the root of the task's worktree. */
  parentPaneId: string;
  /** Where the wrapper, the log and the exit code of each execution go; by default, the tmpdir. */
  stateDir?: string;
  pollMs?: number;
  /** How often it is confirmed with herdr that the pane is still open. */
  paneCheckMs?: number;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Single quote for sh. */
const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * With an allowlist, `cmd.sh` runs with `env -i` and only the allowlist variables the pane
 * has defined, plus those from `env`. The names are already validated as shell names.
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
 * Runs `cmd.sh` with /bin/sh, shows its output in the pane and copies it to `out.log`; the exit code
 * is written at the end with a rename, so it is never read half-written. The cwd and env are set again
 * here because the pane shell's rc files may change them, and stdin is /dev/null so a
 * command that reads the terminal does not hang waiting.
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
   * The env is set on the pane (`pane split --env`), which inherits the herdr server's, not LunasQ's.
   * Throws if herdr cannot open the pane.
   */
  async run(input: ProcessInput): Promise<ProcessResult> {
    const badName = [...Object.keys(input.env ?? {}), ...(input.envAllowlist ?? [])].find(
      (name) => !ENV_NAME.test(name),
    );
    if (badName !== undefined) throw new Error(`invalid variable name: ${badName}`);
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
          const stderr = "the pane was closed before the command finished";
          return { exitCode: PANE_CLOSED_EXIT_CODE, stdout: output, stderr, timedOut: false };
        }
        return { exitCode: end, stdout: output, stderr: "", timedOut: false };
      } finally {
        // Closing the pane kills whatever is still running (timeout or background children).
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
        // The file is looked at again: the command may have finished just before the pane closed.
        if (!panes.some((p) => p.paneId === paneId) && !existsSync(exitFile)) return "pane_closed";
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
    }
  }
}

/** The last OUTPUT_LIMIT_BYTES of the file; empty if it does not exist. */
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
