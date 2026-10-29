// Input de los hooks `SubagentStart` y `SubagentStop` de Claude Code (docs/design.md
// §Verificación con subagentes, ADR uw-19-revisores). Claude Code agrega campos entre versiones,
// así que solo se exige lo que LunasQ registra y el resto se tolera.
import { z } from "zod";

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
