import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunRow, RunSubagentRow } from "@lunasq/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ClaudeTranscriptSource,
  CopilotReviewerTranscriptSource,
  projectDirName,
} from "./sources.ts";

let root: string;
let claudeDir: string;
const worktree = "/Users/yo/work space/lunas.queue-uw-07";

beforeEach(() => {
  // tmpdir() is a symlink on macOS (/var → /private/var): the resolved path is the one Claude Code uses.
  root = realpathSync(mkdtempSync(join(tmpdir(), "lunasq-transcripts-")));
  claudeDir = join(root, ".claude");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const run = (over: Partial<RunRow> = {}) =>
  ({ id: "run-1", agentSession: "sess-1", ...over }) as RunRow;

const subagent = (over: Partial<RunSubagentRow> = {}) =>
  ({
    id: "s1",
    runId: "run-1",
    agentId: "ag-1",
    agentType: "lunasq-code-reviewer",
    startedAt: null,
    stoppedAt: null,
    transcriptPath: null,
    ...over,
  }) as RunSubagentRow;

function writeSession(cwd: string, session: string, content: string) {
  const dir = join(claudeDir, "projects", projectDirName(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${session}.jsonl`), content);
  return join(dir, `${session}.jsonl`);
}

describe("projectDirName", () => {
  it("replaces everything that is not alphanumeric with hyphens, like Claude Code", () => {
    expect(projectDirName("/Users/yo/work space/lunas.queue-uw-07")).toBe(
      "-Users-yo-work-space-lunas-queue-uw-07",
    );
  });
});

describe("ClaudeTranscriptSource", () => {
  it("reads the Run session's transcript from the project directory", async () => {
    writeSession(worktree, "sess-1", '{"type":"user"}\n');
    const source = new ClaudeTranscriptSource({ claudeDir });
    const [main] = await source.forRun({ run: run(), worktreePath: worktree, subagents: [] });
    expect(main).toEqual({ title: "Agent session", jsonl: '{"type":"user"}\n' });
  });

  describe("CopilotReviewerTranscriptSource", () => {
    it("reads the real transcript LunasQ stored for a completed execution", async () => {
      const evidencePath = join(root, "copilot-reviewers");
      const runDir = join(evidencePath, "run-1");
      mkdirSync(runDir, { recursive: true });
      const agentId = "copilot-session-1";
      const transcript = join(runDir, `${agentId}.jsonl`);
      writeFileSync(
        transcript,
        `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "NO FINDINGS" }] } })}\n`,
      );
      const source = new CopilotReviewerTranscriptSource({
        claude: new ClaudeTranscriptSource({ claudeDir }),
        evidencePath,
      });
      const out = await source.forRun({
        run: run({ agentKind: "copilot" }),
        worktreePath: worktree,
        subagents: [
          subagent({
            agentId,
            stoppedAt: new Date(),
            transcriptPath: transcript,
          }),
        ],
      });

      expect(out[1]).toMatchObject({
        title: `Subagente lunasq-code-reviewer (${agentId})`,
        jsonl: expect.stringContaining("NO FINDINGS"),
      });
    });

    it("does not read a Copilot transcript that leaves the Run's private directory", async () => {
      const evidencePath = join(root, "copilot-reviewers");
      mkdirSync(evidencePath);
      const secret = join(root, "secret.jsonl");
      writeFileSync(secret, "no incluir");
      const source = new CopilotReviewerTranscriptSource({
        claude: new ClaudeTranscriptSource({ claudeDir }),
        evidencePath,
      });
      const out = await source.forRun({
        run: run({ agentKind: "copilot" }),
        worktreePath: worktree,
        subagents: [
          subagent({
            agentId: "copilot-session-2",
            stoppedAt: new Date(),
            transcriptPath: secret,
          }),
        ],
      });

      expect(out[1]?.jsonl).toBeNull();
      expect(out[1]?.note).toMatch(/outside the Run.s private directory/);
    });
  });

  it("warns if it does not find the session's transcript", async () => {
    const source = new ClaudeTranscriptSource({ claudeDir });
    const [main] = await source.forRun({ run: run(), worktreePath: worktree, subagents: [] });
    expect(main?.jsonl).toBeNull();
    expect(main?.note).toMatch(/not found/);
  });

  it("warns if the Run has no session", async () => {
    const source = new ClaudeTranscriptSource({ claudeDir });
    const [main] = await source.forRun({
      run: run({ agentSession: null }),
      worktreePath: worktree,
      subagents: [],
    });
    expect(main?.note).toMatch(/without an agent session/);
  });

  it("resolves the worktree by its real path if Claude Code stored the resolved path", async () => {
    const real = join(root, "real");
    mkdirSync(real);
    const link = join(root, "link");
    symlinkSync(real, link);
    writeSession(real, "sess-1", "real\n");
    const source = new ClaudeTranscriptSource({ claudeDir });
    const [main] = await source.forRun({ run: run(), worktreePath: link, subagents: [] });
    expect(main?.jsonl).toBe("real\n");
  });

  it("reads the subagents' transcripts that are under ~/.claude/projects", async () => {
    writeSession(worktree, "sess-1", "main\n");
    const path = writeSession(worktree, "agent-ag-1", "sub\n");
    const source = new ClaudeTranscriptSource({ claudeDir });
    const out = await source.forRun({
      run: run(),
      worktreePath: worktree,
      subagents: [subagent({ transcriptPath: path })],
    });
    expect(out[1]).toEqual({
      title: "Subagente lunasq-code-reviewer (ag-1)",
      jsonl: "sub\n",
    });
  });

  it("does not read a subagent transcript outside ~/.claude/projects", async () => {
    const secret = join(root, "id_rsa");
    writeFileSync(secret, "-----BEGIN OPENSSH PRIVATE KEY-----");
    const source = new ClaudeTranscriptSource({ claudeDir });
    const out = await source.forRun({
      run: run(),
      worktreePath: worktree,
      subagents: [subagent({ transcriptPath: secret })],
    });
    expect(out[1]?.jsonl).toBeNull();
    expect(out[1]?.note).toMatch(/outside/);
  });

  it("does not read another project's transcript or a file that is not .jsonl", async () => {
    const other = writeSession("/Users/yo/otro-proyecto", "agent-x", "ajeno\n");
    const ownDir = join(claudeDir, "projects", projectDirName(worktree));
    mkdirSync(ownDir, { recursive: true });
    const own = join(ownDir, "notas.txt");
    writeFileSync(own, "no es transcript");
    const source = new ClaudeTranscriptSource({ claudeDir });
    const out = await source.forRun({
      run: run(),
      worktreePath: worktree,
      subagents: [
        subagent({ agentId: "a", transcriptPath: other }),
        subagent({ agentId: "b", transcriptPath: own }),
      ],
    });
    expect(out[1]?.jsonl).toBeNull();
    expect(out[1]?.note).toMatch(/another project/);
    expect(out[2]?.jsonl).toBeNull();
  });

  it("does not follow a symlink that points outside ~/.claude/projects", async () => {
    const secret = join(root, "id_rsa");
    writeFileSync(secret, "secreto");
    const dir = join(claudeDir, "projects", "x");
    mkdirSync(dir, { recursive: true });
    symlinkSync(secret, join(dir, "agent-1.jsonl"));
    const source = new ClaudeTranscriptSource({ claudeDir });
    const out = await source.forRun({
      run: run(),
      worktreePath: worktree,
      subagents: [subagent({ transcriptPath: join(dir, "agent-1.jsonl") })],
    });
    expect(out[1]?.jsonl).toBeNull();
  });

  it("warns of a subagent without a transcript or with a file that no longer exists", async () => {
    const source = new ClaudeTranscriptSource({ claudeDir });
    const out = await source.forRun({
      run: run(),
      worktreePath: worktree,
      subagents: [
        subagent({ agentId: "a" }),
        subagent({ agentId: "b", transcriptPath: join(claudeDir, "projects", "x", "no.jsonl") }),
      ],
    });
    expect(out[1]?.note).toMatch(/no transcript/);
    expect(out[2]?.note).toMatch(/not found/);
  });

  it("does not read files larger than the maximum", async () => {
    writeSession(worktree, "sess-1", "x".repeat(100));
    const source = new ClaudeTranscriptSource({ claudeDir, maxBytes: 10 });
    const [main] = await source.forRun({ run: run(), worktreePath: worktree, subagents: [] });
    expect(main?.jsonl).toBeNull();
    expect(main?.note).toMatch(/too large/);
  });
});
