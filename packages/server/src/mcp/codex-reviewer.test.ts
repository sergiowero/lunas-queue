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
import type { ProcessInput, ProcessResult, ProcessRunner } from "@lunasq/adapters";
import type { RunRow } from "@lunasq/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexCliReviewerExecutor } from "./codex-reviewer.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(result: Partial<ProcessResult> = {}, output = "NO FINDINGS") {
  const root = mkdtempSync(join(tmpdir(), "lunasq-codex-reviewer-"));
  dirs.push(root);
  const worktreePath = join(root, "worktree");
  mkdirSync(worktreePath);
  const evidencePath = join(root, "evidence");
  const calls: ProcessInput[] = [];
  const processes: ProcessRunner = {
    run: vi.fn(async (input) => {
      calls.push(input);
      if (result.exitCode === undefined || result.exitCode === 0) {
        writeFileSync(join(evidencePath, "run-1", "codex-session-1.txt"), output);
      }
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        ...result,
      };
    }),
  };
  const executor = new CodexCliReviewerExecutor({ processes, evidencePath });
  const run = { id: "run-1", model: "gpt-5.4" } as RunRow;
  return { root, worktreePath, evidencePath, calls, executor, run };
}

describe("CodexCliReviewerExecutor", () => {
  it("runs a read-only reviewer, keeps the prompt out of argv and stores a private transcript", async () => {
    const { root, worktreePath, evidencePath, calls, executor, run } = setup();
    const instructions = `Review AC-1: ${"line\n".repeat(100)}`;
    const result = await executor.run({
      run,
      worktreePath,
      agentId: "codex-session-1",
      reviewer: "lunasq-security-reviewer",
      instructions,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      cwd: worktreePath,
      envAllowlist: ["PATH", "HOME", "CODEX_HOME", "XDG_CONFIG_HOME"],
      timeoutMs: 300_000,
    });
    expect(calls[0]?.command).toContain(
      'codex exec --sandbox read-only --ignore-user-config --config approval_policy="never"',
    );
    expect(calls[0]?.command).toContain("--model 'gpt-5.4'");
    expect(calls[0]?.command).toContain("--output-last-message");
    expect(calls[0]?.command).not.toContain(instructions);
    const runDir = join(evidencePath, run.id);
    expect(statSync(evidencePath).mode & 0o777).toBe(0o700);
    expect(statSync(runDir).mode & 0o777).toBe(0o700);
    expect(readdirSync(runDir)).toEqual(["codex-session-1.jsonl"]);
    const entries = readFileSync(result.transcriptPath, "utf8")
      .trim()
      .split("\n")
      .map(
        (line) => JSON.parse(line) as { type: string; message: { content: { text: string }[] } },
      );
    expect(entries.map((entry) => entry.type)).toEqual(["user", "assistant"]);
    expect(entries[0]?.message.content[0]?.text).toBe(instructions);
    expect(entries[1]?.message.content[0]?.text).toBe("NO FINDINGS");
    expect(result.output).toBe("NO FINDINGS");
    expect(root).toBeTruthy();
  });

  it("rejects unsuccessful Codex executions without archiving a completed transcript", async () => {
    const { evidencePath, worktreePath, calls, executor, run } = setup({
      exitCode: 1,
      stderr: "authentication required",
    });
    await expect(
      executor.run({
        run,
        worktreePath,
        agentId: "codex-session-2",
        reviewer: "lunasq-code-reviewer",
        instructions: "Review the changes",
      }),
    ).rejects.toThrow("authentication required");
    expect(calls).toHaveLength(1);
    expect(readdirSync(join(evidencePath, run.id))).toEqual([]);
  });

  it("rejects oversized reviewer reports without archiving them", async () => {
    const { evidencePath, worktreePath, executor, run } = setup(
      {},
      "x".repeat(2 * 1024 * 1024 + 1),
    );
    await expect(
      executor.run({
        run,
        worktreePath,
        agentId: "codex-session-1",
        reviewer: "lunasq-code-reviewer",
        instructions: "Review the changes",
      }),
    ).rejects.toThrow("report is too large");
    expect(readdirSync(join(evidencePath, run.id))).toEqual([]);
  });
});
