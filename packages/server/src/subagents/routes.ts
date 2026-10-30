// Endpoint de los hooks SubagentStart y SubagentStop de Claude Code (ADR uw-19-revisores). El
// archivo de settings del dispatcher los manda aquí con el run token en el header, igual que el
// LunasQ MCP. Responder distinto de 2xx no detiene a Claude Code, pero un token inválido responde
// {} sin efectos ni detalles: así una sesión vieja no deja errores en la pantalla del agente.
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
    // Con el session id nativo fijado en el claim, solo cuenta la sesión del Run: otro `claude`
    // que herede el token (un proceso hijo) no deja evidencia en este Run.
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
