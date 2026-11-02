// Endpoint for Claude Code's SubagentStart and SubagentStop hooks (ADR uw-19-revisores). The
// dispatcher's settings file sends them here with the run token in the header, like the
// LunasQ MCP. Answering with a non-2xx does not stop Claude Code, but an invalid token answers
// {} with no effects or details: this way an old session leaves no errors on the agent's screen.
import { type LunasqDatabase, RunRepository, RunSubagentRepository } from "@lunasq/db";
import { RUN_TOKEN_HEADER, SubagentHookInput } from "@lunasq/schemas";
import { Hono } from "hono";

export const SUBAGENT_HOOK_PATH = "/hooks/subagent";

export function subagentHookRoutes(db: LunasqDatabase): Hono {
  const runs = new RunRepository(db);
  const subagents = new RunSubagentRepository(db);
  return new Hono().post("/", async (c) => {
    const token = c.req.header(RUN_TOKEN_HEADER);
    const run = token ? runs.activeByToken(token) : null;
    if (!run) return c.json({});
    const input = SubagentHookInput.safeParse(await c.req.json().catch(() => undefined));
    if (!input.success) {
      return c.json({ error: "invalid_hook_input", message: input.error.message }, 400);
    }
    // With the native session id fixed at the claim, only the Run's session counts: another `claude`
    // that inherits the token (a child process) leaves no evidence in this Run.
    if (run.agentSessionSource === "native" && input.data.session_id !== run.agentSession) {
      return c.json({});
    }
    const { agent_id: agentId, agent_type: agentType } = input.data;
    if (input.data.hook_event_name === "SubagentStart") {
      subagents.recordStart(run.id, { agentId, agentType });
    } else {
      subagents.recordStop(run.id, {
        agentId,
        agentType,
        transcriptPath: input.data.agent_transcript_path,
      });
    }
    return c.json({});
  });
}
