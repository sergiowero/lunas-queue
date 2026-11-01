import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeProcessRunner } from "@lunasq/adapters";
import type { RunRow } from "@lunasq/db";
import { afterEach, describe, expect, it } from "vitest";
import { CopilotCliReviewerExecutor } from "./copilot-reviewer.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "lunasq-copilot-reviewer-"));
  dirs.push(root);
  const agentsPath = join(root, "agents", "lunasq");
  mkdirSync(agentsPath, { recursive: true });
  writeFileSync(join(agentsPath, "security-reviewer.agent.md"), "profile");
  const worktreePath = join(root, "worktree");
  mkdirSync(worktreePath);
  const processes = new FakeProcessRunner(() => ({
    stdout: "[major] src/auth.ts:12 · AC-1 · check",
  }));
  const executor = new CopilotCliReviewerExecutor({
    processes,
    agentsPath,
    evidencePath: join(root, "evidence"),
  });
  const run = { id: "run-1" } as RunRow;
  return { root, agentsPath, worktreePath, processes, executor, run };
}

describe("CopilotCliReviewerExecutor", () => {
  it("usa el perfil personal sin pasar instrucciones en argv y guarda un transcript privado", async () => {
    const { root, worktreePath, processes, executor, run } = setup();
    const instructions = `Revisa este diff: ${"línea\n".repeat(100)}`;
    const result = await executor.run({
      run,
      worktreePath,
      agentId: "copilot-session-1",
      reviewer: "lunasq-security-reviewer",
      instructions,
    });

    expect(processes.calls).toHaveLength(1);
    expect(processes.calls[0]).toMatchObject({
      cwd: worktreePath,
      envAllowlist: ["PATH", "HOME", "COPILOT_HOME", "XDG_CONFIG_HOME"],
      timeoutMs: 300_000,
    });
    expect(processes.calls[0]?.command).toContain("--agent 'lunasq-security-reviewer'");
    expect(processes.calls[0]?.command).toContain("--available-tools view grep glob");
    expect(processes.calls[0]?.command).not.toContain("--trust-folder");
    expect(processes.calls[0]?.command).not.toContain("Revisa este diff");
    const runDir = join(root, "evidence", run.id);
    expect(statSync(join(root, "evidence")).mode & 0o777).toBe(0o700);
    expect(statSync(runDir).mode & 0o777).toBe(0o700);
    expect(readdirSync(runDir)).toEqual(["copilot-session-1.jsonl"]);
    const entries = readFileSync(result.transcriptPath, "utf8")
      .trim()
      .split("\n")
      .map(
        (line) => JSON.parse(line) as { type: string; message: { content: { text: string }[] } },
      );
    expect(entries.map((entry) => entry.type)).toEqual(["user", "assistant"]);
    expect(entries[0]?.message.content[0]?.text).toBe(instructions);
    expect(entries[1]?.message.content[0]?.text).toContain("[major] src/auth.ts");
    expect(result.output).toContain("[major]");
  });

  it("rechaza perfiles ausentes y no intenta una sesión sin configuración", async () => {
    const { executor, run, worktreePath, processes } = setup();
    await expect(
      executor.run({
        run,
        worktreePath,
        agentId: "copilot-session-2",
        reviewer: "lunasq-ui-reviewer",
        instructions: "Revisa",
      }),
    ).rejects.toThrow("falta el perfil Copilot");
    expect(processes.calls).toEqual([]);
  });

  it("no archiva como completada una ejecución con error del CLI", async () => {
    const { executor, run, worktreePath, processes, root } = setup();
    processes.respond(() => ({ exitCode: 1, stderr: "auth required" }));
    await expect(
      executor.run({
        run,
        worktreePath,
        agentId: "copilot-session-3",
        reviewer: "lunasq-security-reviewer",
        instructions: "Revisa",
      }),
    ).rejects.toThrow("auth required");
    expect(readdirSync(join(root, "evidence", run.id))).toEqual([]);
  });
});
