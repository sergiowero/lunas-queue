// HerdrPaneRunner contra FakeHerdr, que ejecuta de verdad lo que recibe con `runInPane`.
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeHerdr } from "../herdr/fake.ts";
import { HerdrPaneRunner, PANE_CLOSED_EXIT_CODE, PANE_TIMEOUT_EXIT_CODE } from "./pane.ts";

describe("HerdrPaneRunner", () => {
  let dir: string;
  let stateDir: string;
  let herdr: FakeHerdr;
  let runner: HerdrPaneRunner;
  let rootPaneId: string;

  beforeEach(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "lunasq-pane-test-")));
    stateDir = realpathSync(mkdtempSync(join(tmpdir(), "lunasq-pane-state-")));
    herdr = new FakeHerdr();
    ({ rootPaneId } = await herdr.ensureWorkspace({ cwd: dir, label: "proj" }));
    runner = new HerdrPaneRunner({
      herdr,
      parentPaneId: rootPaneId,
      stateDir,
      pollMs: 10,
      paneCheckMs: 50,
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  const panes = async () => (await herdr.snapshot()).panes.map((p) => p.paneId);

  it("devuelve exit code y salida, y cierra el pane al terminar", async () => {
    const res = await runner.run({ command: "echo hola; echo error >&2; exit 3", cwd: dir });
    expect(res).toEqual({ exitCode: 3, stdout: "hola\nerror\n", stderr: "", timedOut: false });
    expect(await panes()).toEqual([rootPaneId]);
    expect(readdirSync(stateDir)).toEqual([]);
  });

  it("corre en el cwd dado con el env del pane", async () => {
    const res = await runner.run({
      command: `pwd; printf '%s\\n' "$LUNASQ_TASK_ID"`,
      cwd: dir,
      env: { LUNASQ_TASK_ID: "t-1" },
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe(`${dir}\nt-1\n`);
  });

  it("con envAllowlist el comando no ve el resto del env del pane", async () => {
    process.env.LUNASQ_TEST_SECRET = "no-debe-verse";
    process.env.LUNASQ_TEST_KEEP = "se queda";
    try {
      const res = await runner.run({
        command: `printf '%s|%s|%s|%s' "\${LUNASQ_TEST_SECRET-}" "$LUNASQ_TEST_KEEP" "$LUNASQ_TASK_ID" "\${LUNASQ_NO_EXISTE+definida}"`,
        cwd: dir,
        env: { LUNASQ_TASK_ID: "t-1" },
        envAllowlist: ["LUNASQ_TEST_KEEP", "LUNASQ_NO_EXISTE", "PATH"],
      });
      expect(res).toMatchObject({ exitCode: 0, stdout: "|se queda|t-1|" });
    } finally {
      delete process.env.LUNASQ_TEST_SECRET;
      delete process.env.LUNASQ_TEST_KEEP;
    }
  });

  it("rechaza nombres de la allowlist que no son de shell", async () => {
    await expect(runner.run({ command: "true", cwd: dir, envAllowlist: ["A;rm"] })).rejects.toThrow(
      /variable/,
    );
  });

  it("el comando no lee la terminal: stdin es /dev/null", async () => {
    const res = await runner.run({ command: "cat; echo fin", cwd: dir, timeoutMs: 2_000 });
    expect(res).toMatchObject({ exitCode: 0, stdout: "fin\n", timedOut: false });
  });

  it("rechaza nombres de variable que no son de shell", async () => {
    await expect(runner.run({ command: "true", cwd: dir, env: { "A;rm": "x" } })).rejects.toThrow(
      /variable/,
    );
  });

  it("el comando llega intacto aunque tenga comillas y metacaracteres", async () => {
    const res = await runner.run({ command: `printf '%s' "a 'b' \\$c; d"`, cwd: dir });
    expect(res.stdout).toBe("a 'b' $c; d");
  });

  it("al vencer el timeout cierra el pane, que mata el comando", async () => {
    const started = Date.now();
    const res = await runner.run({
      command: "echo antes; sleep 1; touch tarde",
      cwd: dir,
      timeoutMs: 200,
    });
    expect(Date.now() - started).toBeLessThan(900);
    expect(res).toMatchObject({
      exitCode: PANE_TIMEOUT_EXIT_CODE,
      timedOut: true,
      stdout: "antes\n",
    });
    expect(await panes()).toEqual([rootPaneId]);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(existsSync(join(dir, "tarde"))).toBe(false);
  });

  it("si alguien cierra el pane antes de terminar, es un fallo", async () => {
    const run = runner.run({ command: "sleep 2", cwd: dir });
    let pane: string | undefined;
    while (!pane) {
      pane = (await panes()).find((p) => p !== rootPaneId);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await herdr.closePane(pane);
    const res = await run;
    expect(res).toMatchObject({ exitCode: PANE_CLOSED_EXIT_CODE, timedOut: false });
    expect(res.stderr).toMatch(/pane se cerró/);
  });
});
