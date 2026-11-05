import { describe, expect, it } from "vitest";
import { supervise } from "./dev.ts";

const node = (label: string, code: string) => ({ label, args: ["-e", code] });
const FOREVER = "setInterval(() => {}, 1000)";

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
});
