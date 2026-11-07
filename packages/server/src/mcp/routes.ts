// LunasQ MCP endpoint: stateless Streamable HTTP on Hono (ADR 0001). Each request creates its
// server and its transport, and the run token is read from the header on each call (ADR 0002). An
// invalid token does not cut the handshake: each tools/call rejects it with isError, so the client does not
// interpret a 401 as an OAuth request.
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
  "The handoff is JSON with the versioned schema in packages/schemas/json-schema (schemaVersion 1); if it does not comply, the call is rejected with the errors by path and you can fix it and retry.";

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
        "Goal, approved spec, previous handoffs, Questions, checklist and project conventions. Mandatory before any other tool of the Run.",
      inputSchema: GetTaskContextInput,
    },
    () => guarded("get_task_context", (run) => service.getTaskContext(run)),
  );
  server.registerTool(
    "submit_spec",
    {
      description: `Refinement: delivers the refinement handoff (domain model, requirements, criteria, task list and assumptions) as a new Spec version and closes the Run. ${HANDOFF_HINT}`,
      inputSchema: HandoffInput,
    },
    ({ handoff }) => guarded("submit_spec", (run) => service.submitSpec(run, handoff)),
  );
  server.registerTool(
    "ask_human",
    {
      description:
        "Records a question for the human and returns immediately; end your turn and the answer will arrive as a new prompt. When the answer is a decision between concrete alternatives, send options (2 to 6, each with a short, unique label and, if it helps, a description): the human picks one or writes another answer, and you receive the chosen label or their free text. Without options the question is open and is answered with free text.",
      inputSchema: AskHumanInput,
    },
    (input) => guarded("ask_human", (run) => service.askHuman(run, input)),
  );
  server.registerTool(
    "update_checklist",
    {
      description:
        "Implementation: marks items (T-<n>) of the approved spec's task list; returns the full checklist.",
      inputSchema: UpdateChecklistInput,
    },
    (input) => guarded("update_checklist", (run) => service.updateChecklist(run, input)),
  );
  server.registerTool(
    "submit_for_verification",
    {
      description: `Implementation: declares the end with the implementation handoff (criterion → tests map, branch commits). LunasQ runs the test gate in the worktree; if it is red, the call is rejected with the output. ${HANDOFF_HINT}`,
      inputSchema: HandoffInput,
    },
    ({ handoff }) =>
      guarded("submit_for_verification", (run) => service.submitForVerification(run, handoff)),
  );
  server.registerTool(
    "submit_result",
    {
      description: `Refinement or implementation of a task without code (research, request already implemented or unresolvable): delivers the Result in Markdown with its type (research, already_implemented, not_resolvable) and completes the task without verification or PR. In implementation it is rejected if the branch has commits on top of the base branch. ${HANDOFF_HINT}`,
      inputSchema: HandoffInput,
    },
    ({ handoff }) => guarded("submit_result", (run) => service.submitResult(run, handoff)),
  );
  server.registerTool(
    "run_reviewer",
    {
      description:
        "Copilot CLI in verification: actually launches the specified specialized reviewer, stores its prompt and answer as evidence and returns the report. Include the spec, the diff and the relevant criteria in instructions.",
      inputSchema: RunReviewerInput,
    },
    (input) => guarded("run_reviewer", (run) => service.runReviewer(run, input)),
  );
  server.registerTool(
    "submit_verdict",
    {
      description: `Verification: delivers the pass or reject verdict with a verdict per criterion, the report of the 4 reviewers, must-fix, refuted findings and risk label. ${HANDOFF_HINT}`,
      inputSchema: HandoffInput,
    },
    ({ handoff }) => guarded("submit_verdict", (run) => service.submitVerdict(run, handoff)),
  );
  server.registerTool(
    "report_failure",
    {
      description: "Declares that you cannot continue and why; closes the Run as failed.",
      inputSchema: ReportFailureInput,
    },
    (input) => guarded("report_failure", (run) => service.reportFailure(run, input)),
  );
  return server;
}

/** Hono app with Host and Origin validation for localhost; mounted at /mcp. */
export function mcpRoutes(service: LunasqMcpService): Hono {
  const app = createMcpHonoApp();
  app.all("/", async (c) => {
    const server = buildServer(service, c.req.header(RUN_TOKEN_HEADER));
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw, {
      // createMcpHonoApp leaves the JSON body already read; its Hono does not type the variable.
      parsedBody: c.get("parsedBody" as never),
    });
  });
  return app;
}
