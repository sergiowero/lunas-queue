import { describe, expect, it } from "vitest";
import { EMPTY_USAGE, QueueEntry, RunView, TaskEvidence, TaskUsage } from "./views.ts";

const runId = "0b6d8a8e-6f2b-4a3e-9d55-2f3c1e0a9b10";
const taskId = "6c7a4a26-3c1b-4c8f-8e0b-7d7f0b3c2a11";
const projectId = "9f3b2a1c-5d4e-4f60-8a7b-1c2d3e4f5a60";
const now = new Date("2026-10-29T10:00:00Z");

describe("RunView", () => {
  it("no expone el run token", () => {
    const run = RunView.parse({
      id: runId,
      taskId,
      phase: "implement",
      agentKind: "claude",
      model: null,
      iteration: 0,
      herdrWorkspace: null,
      herdrPane: null,
      herdrName: null,
      agentSession: null,
      agentSessionSource: null,
      startedAt: now,
      endedAt: null,
      result: null,
      failureReason: null,
      handoff: null,
    });
    expect(run).not.toHaveProperty("runToken");
    expect(() => RunView.parse({ ...run, runToken: "secreto" })).toThrow();
  });
});

describe("TaskUsage", () => {
  it("parte de totales en cero", () => {
    const empty = {
      total: EMPTY_USAGE,
      byRun: [],
      byPhase: [],
      byAgent: [],
      byModel: [],
      byReviewer: [],
    };
    expect(TaskUsage.parse(empty).total).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: null,
    });
  });

  it("desglosa por fase (con rework), agente, modelo y revisor", () => {
    const usage = TaskUsage.parse({
      total: EMPTY_USAGE,
      byRun: [],
      byPhase: [{ phase: "rework", usage: EMPTY_USAGE }],
      byAgent: [{ agentKind: "claude", usage: EMPTY_USAGE }],
      byModel: [{ model: "claude-opus-5-5", usage: EMPTY_USAGE }],
      byReviewer: [{ reviewer: "lunasq-code-reviewer", usage: EMPTY_USAGE }],
    });
    expect(usage.byPhase[0]?.phase).toBe("rework");
    expect(() =>
      TaskUsage.parse({ ...usage, byPhase: [{ phase: "otra", usage: EMPTY_USAGE }] }),
    ).toThrow();
  });
});

describe("QueueEntry", () => {
  it("lleva score solo cuando la tarea está en el ready set", () => {
    const task = {
      id: taskId,
      projectId,
      intent: "x",
      title: null,
      tags: [],
      priority: 1,
      state: "draft",
      subState: "queued",
      verificationIteration: 0,
      branch: null,
      worktreePath: null,
      prUrl: null,
      prState: null,
      riskLabel: null,
      causedBy: null,
      createdAt: now,
      updatedAt: now,
    };
    expect(
      QueueEntry.parse({ task, ready: true, score: 3.5, effectivePriority: 2, usage: EMPTY_USAGE }),
    ).toMatchObject({ ready: true, score: 3.5 });
    expect(() =>
      QueueEntry.parse({
        task,
        ready: false,
        score: 3.5,
        effectivePriority: 2,
        usage: EMPTY_USAGE,
      }),
    ).toThrow();
  });
});

describe("TaskEvidence", () => {
  it("guarda la ruta y el markdown", () => {
    expect(
      TaskEvidence.parse({ source: "worktree", path: "/w/lunasq/tasks/a.md", markdown: "# a" }),
    ).toEqual({
      source: "worktree",
      path: "/w/lunasq/tasks/a.md",
      markdown: "# a",
    });
  });
});
