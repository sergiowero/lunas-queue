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
import { finalMessage, OpencodeCliReviewerExecutor } from "./opencode-reviewer.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const textEvent = (messageID: string, text: string) =>
  JSON.stringify({ type: "text", part: { type: "text", messageID, text } });
const toolEvent = JSON.stringify({ type: "tool_use", part: { type: "tool", tool: "bash" } });

function setup(
  result: Partial<ProcessResult> = {},
  events = [toolEvent, textEvent("m2", "NO FINDINGS")].join("\n"),
) {
  const root = mkdtempSync(join(tmpdir(), "lunasq-opencode-reviewer-"));
  dirs.push(root);
  const worktreePath = join(root, "worktree");
  mkdirSync(worktreePath);
  const evidencePath = join(root, "evidence");
  const calls: ProcessInput[] = [];
  const seen: { prompt: string; promptMode: number }[] = [];
  const processes: ProcessRunner = {
    run: vi.fn(async (input) => {
      calls.push(input);
      const runDir = join(evidencePath, "run-1");
      const promptPath = /< '([^']+)'/.exec(input.command)?.[1] ?? "";
      const eventsPath = /> '([^']+)'/.exec(input.command)?.[1] ?? "";
      seen.push({
        prompt: readFileSync(promptPath, "utf8"),
        promptMode: statSync(promptPath).mode & 0o777,
      });
      if (result.exitCode === undefined || result.exitCode === 0) {
        writeFileSync(eventsPath, events);
      }
      expect(readdirSync(runDir).length).toBeGreaterThan(0);
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false, ...result };
    }),
  };
  const executor = new OpencodeCliReviewerExecutor({ processes, evidencePath });
  const run = { id: "run-1", model: "anthropic/claude-sonnet-4" } as RunRow;
  return { worktreePath, evidencePath, calls, seen, executor, run, processes };
}

const input = (agentId = "opencode-session-1") => ({
  agentId,
  reviewer: "lunasq-code-reviewer" as const,
  instructions: `Review AC-1: ${"line\n".repeat(100)}`,
});

describe("OpencodeCliReviewerExecutor", () => {
  it("runs `opencode run` read-only in the worktree with the prompt from a private file", async () => {
    const { worktreePath, evidencePath, calls, seen, executor, run } = setup();
    const request = input();

    const result = await executor.run({ run, worktreePath, ...request });

    expect(calls).toHaveLength(1);
    const call = calls[0] as ProcessInput;
    expect(call.cwd).toBe(worktreePath);
    expect(call.timeoutMs).toBe(300_000);
    expect(call.command).toMatch(/^opencode run --pure --format json /);
    expect(call.command).toContain("--model 'anthropic/claude-sonnet-4'");
    expect(call.command).not.toContain(request.instructions);
    expect(call.command).not.toContain("--auto");
    const config = JSON.parse(call.env?.OPENCODE_CONFIG_CONTENT ?? "null");
    expect(config.permission).toMatchObject({ edit: "deny", external_directory: "deny" });
    expect(config).not.toHaveProperty("mcp");
    // The worktree's own opencode.json / .opencode/ cannot change the reviewer's permissions.
    expect(call.env?.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("1");
    expect(call.envAllowlist).not.toContain("GH_TOKEN");
    // The prompt reached the process through a 0600 file, which is removed afterwards.
    expect(seen[0]).toEqual({ prompt: request.instructions, promptMode: 0o600 });
    const runDir = join(evidencePath, run.id);
    expect(statSync(evidencePath).mode & 0o777).toBe(0o700);
    expect(statSync(runDir).mode & 0o777).toBe(0o700);
    expect(readdirSync(runDir)).toEqual(["opencode-session-1.jsonl"]);
    expect(statSync(result.transcriptPath).mode & 0o777).toBe(0o600);
    const entries = readFileSync(result.transcriptPath, "utf8")
      .trim()
      .split("\n")
      .map(
        (line) => JSON.parse(line) as { type: string; message: { content: { text: string }[] } },
      );
    expect(entries.map((e) => e.type)).toEqual(["user", "assistant"]);
    expect(entries[0]?.message.content[0]?.text).toBe(request.instructions);
    expect(result.output).toBe("NO FINDINGS");
  });

  it("omits --model when the Run has no model", async () => {
    const { worktreePath, calls, executor, run } = setup();
    await executor.run({ run: { ...run, model: null }, worktreePath, ...input() });
    expect(calls[0]?.command).not.toContain("--model");
  });

  it.each([
    [
      "exits non-zero",
      { exitCode: 1, stderr: "authentication required" },
      "authentication required",
    ],
    ["times out", { exitCode: 1, timedOut: true, stderr: "" }, "by timeout"],
  ])(
    "a reviewer that %s returns an error naming it and records nothing",
    async (_, result, cause) => {
      const { evidencePath, worktreePath, executor, run } = setup(result);
      await expect(executor.run({ run, worktreePath, ...input() })).rejects.toThrow(
        new RegExp(`OpenCode lunasq-code-reviewer.*${cause}`),
      );
      expect(readdirSync(join(evidencePath, run.id))).toEqual([]);
    },
  );

  it("a reviewer that produces no report returns an error and records nothing", async () => {
    const { evidencePath, worktreePath, executor, run } = setup({}, toolEvent);
    await expect(executor.run({ run, worktreePath, ...input() })).rejects.toThrow(
      "OpenCode lunasq-code-reviewer finished without a report",
    );
    expect(readdirSync(join(evidencePath, run.id))).toEqual([]);
  });

  it("rejects an oversized report without archiving it", async () => {
    const { evidencePath, worktreePath, executor, run } = setup(
      {},
      textEvent("m1", "x".repeat(2 * 1024 * 1024 + 1)),
    );
    await expect(executor.run({ run, worktreePath, ...input() })).rejects.toThrow(
      "report is too large",
    );
    expect(readdirSync(join(evidencePath, run.id))).toEqual([]);
  });

  it.each(["../escape", "a/b", "A_B", "", "x".repeat(65), "with space", "a;rm -rf"])(
    "rejects the reviewer id %j before writing any file or running any process",
    async (agentId) => {
      const { evidencePath, worktreePath, processes, executor, run } = setup();
      await expect(executor.run({ run, worktreePath, ...input(agentId) })).rejects.toThrow(
        "not a safe file name",
      );
      expect(processes.run).not.toHaveBeenCalled();
      expect(() => readdirSync(evidencePath)).toThrow();
    },
  );
});

describe("finalMessage", () => {
  it("joins the text parts of the last message and ignores tool events and broken lines", () => {
    const events = [
      "not json at all",
      textEvent("m1", "intermediate"),
      toolEvent,
      textEvent("m2", "FINDING 1\n"),
      textEvent("m2", "FINDING 2"),
    ].join("\n");
    expect(finalMessage(events)).toBe("FINDING 1\nFINDING 2");
  });

  it("is empty without text events", () => {
    expect(finalMessage(toolEvent)).toBe("");
  });
});
