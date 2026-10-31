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
  // tmpdir() es un symlink en macOS (/var → /private/var): la ruta resuelta es la que usa Claude Code.
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
  it("reemplaza todo lo que no es alfanumérico por guiones, como Claude Code", () => {
    expect(projectDirName("/Users/yo/work space/lunas.queue-uw-07")).toBe(
      "-Users-yo-work-space-lunas-queue-uw-07",
    );
  });
});

describe("ClaudeTranscriptSource", () => {
  it("lee el transcript de la sesión del Run desde el directorio del proyecto", async () => {
    writeSession(worktree, "sess-1", '{"type":"user"}\n');
    const source = new ClaudeTranscriptSource({ claudeDir });
    const [main] = await source.forRun({ run: run(), worktreePath: worktree, subagents: [] });
    expect(main).toEqual({ title: "Sesión del agente", jsonl: '{"type":"user"}\n' });
  });

  describe("CopilotReviewerTranscriptSource", () => {
    it("lee el transcript real que LunasQ guardó para una ejecución completada", async () => {
      const evidencePath = join(root, "copilot-reviewers");
      const runDir = join(evidencePath, "run-1");
      mkdirSync(runDir, { recursive: true });
      const agentId = "copilot-session-1";
      const transcript = join(runDir, `${agentId}.jsonl`);
      writeFileSync(
        transcript,
        `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "SIN HALLAZGOS" }] } })}\n`,
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
        jsonl: expect.stringContaining("SIN HALLAZGOS"),
      });
    });

    it("no lee un transcript Copilot que sale del directorio privado del Run", async () => {
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
      expect(out[1]?.note).toMatch(/fuera del directorio privado/);
    });
  });

  it("avisa si no encuentra el transcript de la sesión", async () => {
    const source = new ClaudeTranscriptSource({ claudeDir });
    const [main] = await source.forRun({ run: run(), worktreePath: worktree, subagents: [] });
    expect(main?.jsonl).toBeNull();
    expect(main?.note).toMatch(/no se encontró/);
  });

  it("avisa si el Run no tiene sesión", async () => {
    const source = new ClaudeTranscriptSource({ claudeDir });
    const [main] = await source.forRun({
      run: run({ agentSession: null }),
      worktreePath: worktree,
      subagents: [],
    });
    expect(main?.note).toMatch(/sin sesión/);
  });

  it("resuelve el worktree por su ruta real si Claude Code guardó la ruta resuelta", async () => {
    const real = join(root, "real");
    mkdirSync(real);
    const link = join(root, "link");
    symlinkSync(real, link);
    writeSession(real, "sess-1", "real\n");
    const source = new ClaudeTranscriptSource({ claudeDir });
    const [main] = await source.forRun({ run: run(), worktreePath: link, subagents: [] });
    expect(main?.jsonl).toBe("real\n");
  });

  it("lee los transcripts de los subagentes que están bajo ~/.claude/projects", async () => {
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

  it("no lee un transcript de subagente fuera de ~/.claude/projects", async () => {
    const secret = join(root, "id_rsa");
    writeFileSync(secret, "-----BEGIN OPENSSH PRIVATE KEY-----");
    const source = new ClaudeTranscriptSource({ claudeDir });
    const out = await source.forRun({
      run: run(),
      worktreePath: worktree,
      subagents: [subagent({ transcriptPath: secret })],
    });
    expect(out[1]?.jsonl).toBeNull();
    expect(out[1]?.note).toMatch(/fuera de/);
  });

  it("no lee el transcript de otro proyecto ni un archivo que no es .jsonl", async () => {
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
    expect(out[1]?.note).toMatch(/otro proyecto/);
    expect(out[2]?.jsonl).toBeNull();
  });

  it("no sigue un symlink que apunta fuera de ~/.claude/projects", async () => {
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

  it("avisa de un subagente sin transcript o con un archivo que ya no existe", async () => {
    const source = new ClaudeTranscriptSource({ claudeDir });
    const out = await source.forRun({
      run: run(),
      worktreePath: worktree,
      subagents: [
        subagent({ agentId: "a" }),
        subagent({ agentId: "b", transcriptPath: join(claudeDir, "projects", "x", "no.jsonl") }),
      ],
    });
    expect(out[1]?.note).toMatch(/sin transcript/);
    expect(out[2]?.note).toMatch(/no se encontró/);
  });

  it("no lee archivos más grandes que el máximo", async () => {
    writeSession(worktree, "sess-1", "x".repeat(100));
    const source = new ClaudeTranscriptSource({ claudeDir, maxBytes: 10 });
    const [main] = await source.forRun({ run: run(), worktreePath: worktree, subagents: [] });
    expect(main?.jsonl).toBeNull();
    expect(main?.note).toMatch(/demasiado grande/);
  });
});
