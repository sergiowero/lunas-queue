import { describe, expect, it } from "vitest";
import { RunReviewerInput, SubagentHookInput } from "./subagents.ts";

// Real inputs of Claude Code 2.1.312 (spike of ADR uw-19-revisores), trimmed.
const start = {
  session_id: "db6d30cd-c5d8-4687-a579-1d01d4945679",
  transcript_path: "/Users/u/.claude/projects/p/db6d30cd.jsonl",
  cwd: "/tmp/proj",
  prompt_id: "37bcd5c8-3872-4630-9439-ba772896dee6",
  agent_id: "a5b9c0d419ac8ac87",
  agent_type: "lunasq-code-reviewer",
  hook_event_name: "SubagentStart",
};
const stop = {
  ...start,
  permission_mode: "default",
  effort: { level: "medium" },
  hook_event_name: "SubagentStop",
  stop_hook_active: false,
  agent_transcript_path: "/Users/u/.claude/projects/p/db6d30cd/subagents/agent-a5b9.jsonl",
  last_assistant_message: "SIN HALLAZGOS",
  background_tasks: [],
  session_crons: [],
};

describe("SubagentHookInput", () => {
  it("reads SubagentStart: agent and type", () => {
    expect(SubagentHookInput.parse(start)).toMatchObject({
      hook_event_name: "SubagentStart",
      agent_id: "a5b9c0d419ac8ac87",
      agent_type: "lunasq-code-reviewer",
    });
  });

  it("reads SubagentStop with the subagent transcript and tolerates new fields", () => {
    expect(SubagentHookInput.parse({ ...stop, campo_futuro: 1 })).toMatchObject({
      hook_event_name: "SubagentStop",
      agent_transcript_path: stop.agent_transcript_path,
    });
  });

  describe("RunReviewerInput", () => {
    it("validates a known reviewer and bounds the context that will be sent to the CLI", () => {
      expect(
        RunReviewerInput.parse({
          reviewer: "lunasq-code-reviewer",
          instructions: "Revisa AC-1 y el diff",
        }),
      ).toEqual({
        reviewer: "lunasq-code-reviewer",
        instructions: "Revisa AC-1 y el diff",
      });
      expect(
        RunReviewerInput.safeParse({
          reviewer: "otro-agente",
          instructions: "Revisa",
        }).success,
      ).toBe(false);
      expect(
        RunReviewerInput.safeParse({
          reviewer: "lunasq-code-reviewer",
          instructions: " ",
        }).success,
      ).toBe(false);
    });
  });

  it("rejects other events and agents without id or without type", () => {
    expect(SubagentHookInput.safeParse({ ...start, hook_event_name: "Stop" }).success).toBe(false);
    expect(SubagentHookInput.safeParse({ ...start, agent_id: "" }).success).toBe(false);
    const { agent_type: _, ...untyped } = start;
    expect(SubagentHookInput.safeParse(untyped).success).toBe(false);
  });
});
