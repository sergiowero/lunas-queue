import { describe, expect, it } from "vitest";
import { type ExecFn, execHerdr, HerdrCli } from "./cli.ts";
import { HerdrError } from "./errors.ts";

function fakeExec(stdout: string, stderr = "", exitCode = 0) {
  const calls: { file: string; args: string[] }[] = [];
  const exec: ExecFn = async (file, args) => {
    calls.push({ file, args });
    return { stdout, stderr, exitCode };
  };
  return { exec, calls };
}

describe("HerdrCli", () => {
  it("prepends the session and returns result", async () => {
    const { exec, calls } = fakeExec('{"id":"cli:pane:close","result":{"type":"ok"}}\n');
    const cli = new HerdrCli({ bin: "/bin/herdr", session: "s1", exec });
    expect(await cli.json(["pane", "close", "w1:p2"])).toEqual({ type: "ok" });
    expect(calls).toEqual([
      { file: "/bin/herdr", args: ["--session", "s1", "pane", "close", "w1:p2"] },
    ]);
  });

  it("without a session uses the default one", async () => {
    const { exec, calls } = fakeExec("");
    await new HerdrCli({ exec }).text(["pane", "report-metadata", "w1:p1"]);
    expect(calls[0]).toEqual({ file: "herdr", args: ["pane", "report-metadata", "w1:p1"] });
  });

  it("converts the stderr JSON error into HerdrError with its code", async () => {
    const stderr =
      '{"error":{"code":"agent_not_found","message":"agent target x not found"},"id":"cli:agent:get"}\n';
    const { exec } = fakeExec("", stderr, 1);
    const err = await new HerdrCli({ exec }).json(["agent", "get", "x"]).catch((e) => e);
    expect(err).toBeInstanceOf(HerdrError);
    expect(err).toMatchObject({ code: "agent_not_found" });
  });

  it("exit 2 without JSON is a CLI usage error", async () => {
    const { exec } = fakeExec("", "error: unexpected argument", 2);
    await expect(new HerdrCli({ exec }).json(["pane", "nope"])).rejects.toMatchObject({
      code: "cli_usage",
    });
  });

  it("kills the process that does not respond within the limit", async () => {
    await expect(execHerdr("sleep", ["5"], 100)).rejects.toMatchObject({ code: "cli_timeout" });
  });

  it("rejects an output that is not JSON", async () => {
    const { exec } = fakeExec("hola");
    await expect(new HerdrCli({ exec }).json(["api", "snapshot"])).rejects.toMatchObject({
      code: "invalid_response",
    });
  });
});
