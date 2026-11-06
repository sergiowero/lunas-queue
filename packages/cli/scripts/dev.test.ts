import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { supervise } from "./dev.ts";

const node = (label: string, code: string) => ({ label, args: ["-e", code] });
const FOREVER = "setInterval(() => {}, 1000)";

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("supervise", () => {
  it("writes each process's output line by line with its label", async () => {
    const out: string[] = [];
    const code = await supervise(
      [node("a", 'process.stdout.write("uno\\ndo"); process.stdout.write("s\\ntres")')],
      (text) => out.push(text),
    );
    expect(code).toBe(0);
    expect(out.join("")).toBe("[a] uno\n[a] dos\n[a] tres\n");
  });

  it("if one process ends it stops the other and returns the exit code of the first", async () => {
    const code = await supervise(
      [node("forever", FOREVER), node("fails", "process.exit(3)")],
      () => {},
    );
    expect(code).toBe(3);
  });

  it("a signal stops every process and the exit code is 0", async () => {
    const running = supervise([node("a", FOREVER), node("b", FOREVER)], () => {});
    process.emit("SIGINT");
    await expect(running).resolves.toBe(0);
  });

  it("stops a process in watch mode along with the program it started", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lunasq-dev-"));
    try {
      const pidFile = join(dir, "pid");
      const program = join(dir, "program.js");
      writeFileSync(
        program,
        `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
         console.log("ready");
         ${FOREVER};`,
      );
      const started = Promise.withResolvers<void>();
      const running = supervise([{ label: "w", args: ["--watch", program] }], (text) => {
        if (text.includes("ready")) started.resolve();
      });
      await started.promise;
      process.emit("SIGINT");
      await expect(running).resolves.toBe(0);
      const pid = Number(readFileSync(pidFile, "utf8"));
      await expect.poll(() => isAlive(pid)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
