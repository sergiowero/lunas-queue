// Endpoint del LunasQ MCP: Streamable HTTP stateless sobre Hono (ADR 0001). Cada request crea su
// servidor y su transporte, y el run token se lee del header en cada llamada (ADR 0002). Un token
// inválido no corta el handshake: cada tools/call lo rechaza con isError, así el cliente no
// interpreta un 401 como pedido de OAuth.
import type { RunRow } from "@lunasq/db";
import {
  AskHumanInput,
  GetTaskContextInput,
  HandoffInput,
  ReportFailureInput,
  RunReviewerInput,
  UpdateChecklistInput,
} from "@lunasq/schemas";
import { createMcpHonoApp } from "@modelcontextprotocol/hono";
import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import type { Hono } from "hono";
import type { LunasqMcpService, Outcome, ToolName } from "./service.ts";

export const RUN_TOKEN_HEADER = "x-lunasq-run-token";

const SERVER_INFO = { name: "lunasq", version: "1.0.0" };

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function toResult(outcome: Outcome<unknown>): ToolResult {
  if (outcome.ok) return { content: [{ type: "text", text: JSON.stringify(outcome.data) }] };
  const { code, ...rest } = outcome.error;
  return {
    content: [{ type: "text", text: JSON.stringify({ error: code, ...rest }) }],
    isError: true,
  };
}

const HANDOFF_HINT =
  "El handoff es JSON con el esquema versionado de packages/schemas/json-schema (schemaVersion 1); si no cumple, la llamada se rechaza con los errores por ruta y puedes corregir y reintentar.";

function buildServer(service: LunasqMcpService, token: string | undefined): McpServer {
  const server = new McpServer(SERVER_INFO);
  const guarded = async (
    tool: ToolName,
    call: (run: RunRow) => Outcome<unknown> | Promise<Outcome<unknown>>,
  ) => {
    const auth = service.authorize(token, tool);
    if (!auth.ok) return toResult(auth);
    return toResult(await call(auth.data));
  };

  server.registerTool(
    "get_task_context",
    {
      description:
        "Intent, spec aprobada, handoffs previos, Questions, checklist y convenciones del proyecto. Obligatoria antes de cualquier otra tool del Run.",
      inputSchema: GetTaskContextInput,
    },
    () => guarded("get_task_context", (run) => service.getTaskContext(run)),
  );
  server.registerTool(
    "submit_spec",
    {
      description: `Refinamiento: entrega el handoff de refinamiento (modelo de dominio, requerimientos, criterios, task list y supuestos) como nueva versión de Spec y cierra el Run. ${HANDOFF_HINT}`,
      inputSchema: HandoffInput,
    },
    ({ handoff }) => guarded("submit_spec", (run) => service.submitSpec(run, handoff)),
  );
  server.registerTool(
    "ask_human",
    {
      description:
        "Registra una pregunta para el humano y regresa de inmediato; termina tu turno y la respuesta llegará como un prompt nuevo.",
      inputSchema: AskHumanInput,
    },
    (input) => guarded("ask_human", (run) => service.askHuman(run, input)),
  );
  server.registerTool(
    "update_checklist",
    {
      description:
        "Implementación: marca items (T-<n>) de la task list de la spec aprobada; devuelve el checklist completo.",
      inputSchema: UpdateChecklistInput,
    },
    (input) => guarded("update_checklist", (run) => service.updateChecklist(run, input)),
  );
  server.registerTool(
    "submit_for_verification",
    {
      description: `Implementación: declara el fin con el handoff de implementación (mapa criterio → tests, commits del branch). LunasQ corre el gate de tests en el worktree; si está en rojo, se rechaza con la salida. ${HANDOFF_HINT}`,
      inputSchema: HandoffInput,
    },
    ({ handoff }) =>
      guarded("submit_for_verification", (run) => service.submitForVerification(run, handoff)),
  );
  server.registerTool(
    "run_reviewer",
    {
      description:
        "Copilot CLI en verificación: lanza de verdad el revisor especializado indicado, guarda su prompt y respuesta como evidencia y devuelve el reporte. Incluye la spec, el diff y los criterios relevantes en instructions.",
      inputSchema: RunReviewerInput,
    },
    (input) => guarded("run_reviewer", (run) => service.runReviewer(run, input)),
  );
  server.registerTool(
    "submit_verdict",
    {
      description: `Verificación: entrega el veredicto pass o reject con veredicto por criterio, reporte de los 4 revisores, must-fix, hallazgos refutados y etiqueta de riesgo. ${HANDOFF_HINT}`,
      inputSchema: HandoffInput,
    },
    ({ handoff }) => guarded("submit_verdict", (run) => service.submitVerdict(run, handoff)),
  );
  server.registerTool(
    "report_failure",
    {
      description: "Declara que no puedes continuar y por qué; cierra el Run como fallido.",
      inputSchema: ReportFailureInput,
    },
    (input) => guarded("report_failure", (run) => service.reportFailure(run, input)),
  );
  return server;
}

/** App de Hono con validación de Host y Origin para localhost; se monta en /mcp. */
export function mcpRoutes(service: LunasqMcpService): Hono {
  const app = createMcpHonoApp();
  app.all("/", async (c) => {
    const server = buildServer(service, c.req.header(RUN_TOKEN_HEADER));
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw, {
      // createMcpHonoApp deja el cuerpo JSON ya leído; su Hono no tipa la variable.
      parsedBody: c.get("parsedBody" as never),
    });
  });
  return app;
}
