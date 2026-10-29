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
  it("antepone la sesión y devuelve result", async () => {
    const { exec, calls } = fakeExec('{"id":"cli:pane:close","result":{"type":"ok"}}\n');
    const cli = new HerdrCli({ bin: "/bin/herdr", session: "s1", exec });
    expect(await cli.json(["pane", "close", "w1:p2"])).toEqual({ type: "ok" });
    expect(calls).toEqual([
      { file: "/bin/herdr", args: ["--session", "s1", "pane", "close", "w1:p2"] },
    ]);
  });

  it("sin sesión usa la por defecto", async () => {
    const { exec, calls } = fakeExec("");
    await new HerdrCli({ exec }).text(["pane", "report-metadata", "w1:p1"]);
    expect(calls[0]).toEqual({ file: "herdr", args: ["pane", "report-metadata", "w1:p1"] });
  });

  it("convierte el error JSON de stderr en HerdrError con su code", async () => {
    const stderr =
      '{"error":{"code":"agent_not_found","message":"agent target x not found"},"id":"cli:agent:get"}\n';
    const { exec } = fakeExec("", stderr, 1);
    const err = await new HerdrCli({ exec }).json(["agent", "get", "x"]).catch((e) => e);
    expect(err).toBeInstanceOf(HerdrError);
    expect(err).toMatchObject({ code: "agent_not_found" });
  });

  it("exit 2 sin JSON es un error de uso del CLI", async () => {
    const { exec } = fakeExec("", "error: unexpected argument", 2);
    await expect(new HerdrCli({ exec }).json(["pane", "nope"])).rejects.toMatchObject({
      code: "cli_usage",
    });
  });

  it("mata el proceso que no responde dentro del límite", async () => {
    await expect(execHerdr("sleep", ["5"], 100)).rejects.toMatchObject({ code: "cli_timeout" });
  });

  it("rechaza una salida que no es JSON", async () => {
    const { exec } = fakeExec("hola");
    await expect(new HerdrCli({ exec }).json(["api", "snapshot"])).rejects.toMatchObject({
      code: "invalid_response",
    });
  });
});
