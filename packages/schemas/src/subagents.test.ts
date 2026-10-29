import { describe, expect, it } from "vitest";
import { SubagentHookInput } from "./subagents.ts";

// Inputs reales de Claude Code 2.1.312 (spike de ADR uw-19-revisores), recortados.
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
  it("lee SubagentStart: agente y tipo", () => {
    expect(SubagentHookInput.parse(start)).toMatchObject({
      hook_event_name: "SubagentStart",
      agent_id: "a5b9c0d419ac8ac87",
      agent_type: "lunasq-code-reviewer",
    });
  });

  it("lee SubagentStop con el transcript del subagente y tolera campos nuevos", () => {
    expect(SubagentHookInput.parse({ ...stop, campo_futuro: 1 })).toMatchObject({
      hook_event_name: "SubagentStop",
      agent_transcript_path: stop.agent_transcript_path,
    });
  });

  it("rechaza otros eventos y agentes sin id o sin tipo", () => {
    expect(SubagentHookInput.safeParse({ ...start, hook_event_name: "Stop" }).success).toBe(false);
    expect(SubagentHookInput.safeParse({ ...start, agent_id: "" }).success).toBe(false);
    const { agent_type: _, ...untyped } = start;
    expect(SubagentHookInput.safeParse(untyped).success).toBe(false);
  });
});
