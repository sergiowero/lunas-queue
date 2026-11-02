// Input of the Claude Code `SubagentStart` and `SubagentStop` hooks (docs/design.md
// §Verification with subagents, ADR uw-19-revisores). Claude Code adds fields between versions,
// so only what LunasQ records is required and the rest is tolerated.
import { z } from "zod";
import { REVIEWER_NAMES } from "./handoff/index.ts";

const subagentShape = {
  session_id: z.string().min(1),
  agent_id: z.string().min(1).max(128),
  agent_type: z.string().min(1).max(200),
};

export const SubagentStartInput = z.looseObject({
  ...subagentShape,
  hook_event_name: z.literal("SubagentStart"),
});

export const SubagentStopInput = z.looseObject({
  ...subagentShape,
  hook_event_name: z.literal("SubagentStop"),
  agent_transcript_path: z.string().min(1).optional(),
});

export const SubagentHookInput = z.discriminatedUnion("hook_event_name", [
  SubagentStartInput,
  SubagentStopInput,
]);
export type SubagentHookInput = z.infer<typeof SubagentHookInput>;

export const RunReviewerInput = z.strictObject({
  reviewer: z.enum(REVIEWER_NAMES),
  instructions: z.string().trim().min(1).max(64_000),
});
export type RunReviewerInput = z.infer<typeof RunReviewerInput>;
