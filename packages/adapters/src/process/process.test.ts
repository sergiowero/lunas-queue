import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeProcessRunner } from "./fake.ts";
import { isProcessError, OUTPUT_LIMIT_BYTES, ShellProcessRunner } from "./real.ts";
import type { ProcessRunner } from "./types.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lunasq-proc-")));
  dirs.push(dir);
  return dir;
}

describe("ShellProcessRunner", () => {
  const runner: ProcessRunner = new ShellProcessRunner();

  it("corre el comando con sh en el cwd y con el env dado", async () => {
    const cwd = tempDir();
    const res = await runner.run({
      command: 'pwd; echo "$LUNASQ_X"; echo err >&2',
      cwd,
      env: { LUNASQ_X: "hola" },
    });
    expect(res).toEqual({
      exitCode: 0,
      stdout: `${cwd}\nhola\n`,
      stderr: "err\n",
      timedOut: false,
    });
  });

  it("hereda el env del proceso", async () => {
    const res = await runner.run({ command: 'echo "$HOME"', cwd: tempDir() });
    expect(res.stdout.trim()).toBe(process.env.HOME);
  });

  it("devuelve el exit code sin lanzar", async () => {
    const res = await runner.run({ command: "echo uno; exit 3", cwd: tempDir() });
    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("uno\n");
  });

  it("mata el grupo de procesos al vencer el timeout", async () => {
    const started = Date.now();
    const res = await runner.run({
      command: "sleep 5 & sleep 5; wait",
      cwd: tempDir(),
      timeoutMs: 200,
    });
    expect(res.timedOut).toBe(true);
    expect(res.exitCode).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("no se cuelga si el comando deja un proceso en background con los pipes abiertos", async () => {
    const started = Date.now();
    const res = await runner.run({ command: "echo listo; sleep 30 &", cwd: tempDir() });
    expect(res).toMatchObject({ exitCode: 0, stdout: "listo\n", timedOut: false });
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("conserva solo el final de una salida enorme", async () => {
    const res = await runner.run({
      command: `head -c ${OUTPUT_LIMIT_BYTES * 2} /dev/zero | tr '\\0' a; echo FIN`,
      cwd: tempDir(),
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.length).toBeLessThanOrEqual(OUTPUT_LIMIT_BYTES);
    expect(res.stdout.endsWith("aFIN\n")).toBe(true);
  });

  it("lanza spawn_failed si el cwd no existe", async () => {
    const err = await runner
      .run({ command: "true", cwd: join(tempDir(), "no-existe") })
      .catch((e) => e);
    expect(isProcessError(err, "spawn_failed")).toBe(true);
  });
});

describe("FakeProcessRunner", () => {
  it("registra las llamadas y responde con éxito por defecto", async () => {
    const fake = new FakeProcessRunner();
    const res = await fake.run({ command: "pnpm install", cwd: "/wt", env: { A: "1" } });
    expect(res).toEqual({ exitCode: 0, stdout: "", stderr: "", timedOut: false });
    expect(fake.calls).toEqual([{ command: "pnpm install", cwd: "/wt", env: { A: "1" } }]);
  });

  it("responde con el handler configurado", async () => {
    const fake = new FakeProcessRunner(({ command }) =>
      command === "falla" ? { exitCode: 1, stderr: "boom" } : {},
    );
    expect(await fake.run({ command: "falla", cwd: "/wt" })).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "boom",
      timedOut: false,
    });
    expect((await fake.run({ command: "ok", cwd: "/wt" })).exitCode).toBe(0);
  });
});
