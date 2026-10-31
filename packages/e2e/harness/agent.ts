// El agente guionado: hace lo que Claude Code haría en cada fase, pero con el LunasQ MCP real, los
// hooks de subagentes por HTTP y git real. El guion lo decide la fase y el intent de la tarea:
//   · `[pregunta]` → el refinamiento pregunta antes de entregar la spec.
//   · `[rework]`   → el primer veredicto de verificación es reject.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { RUN_ENV, RUN_TOKEN_HEADER } from "@lunasq/schemas";
import { SUBAGENT_HOOK_PATH } from "@lunasq/server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { git } from "./git.ts";
import type { PromptedAgent } from "./scripted-herdr.ts";

const EXAMPLES = new URL("../../schemas/examples/handoff/v1/valid/", import.meta.url);

type Example = "refinement" | "implementation" | "verification-pass" | "verification-reject";
type Json = Record<string, unknown>;

function handoff(example: Example, ids: { taskId: string; runId: string }, summary?: string): Json {
  const base = JSON.parse(readFileSync(new URL(`${example}.json`, EXAMPLES), "utf8")) as Json;
  return { ...base, ...ids, ...(summary && { summary }) };
}

interface Context {
  task: { intent: string; worktreePath: string | null };
  run: { iteration: number };
  questions: { status: string; answer: string | null }[];
  verificationHistory: unknown[];
}

class McpSession {
  readonly #client: Client;

  private constructor(client: Client) {
    this.#client = client;
  }

  static async open(baseUrl: string, token: string): Promise<McpSession> {
    const client = new Client({ name: "lunasq-e2e-agent", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { [RUN_TOKEN_HEADER]: token } },
      }),
    );
    return new McpSession(client);
  }

  /** Llama a una tool; un `isError` es un fallo del guion, no un resultado. */
  async call<T = Json>(name: string, args: Json = {}): Promise<T> {
    const result = await this.#client.callTool({ name, arguments: args });
    const [first] = result.content as { text: string }[];
    if (result.isError) throw new Error(`${name}: ${first?.text}`);
    return JSON.parse(first?.text ?? "{}") as T;
  }

  close(): Promise<void> {
    return this.#client.close();
  }
}

/** Hooks SubagentStart/Stop de Claude Code: la evidencia de que cada revisor corrió. */
async function reviewersRan(
  baseUrl: string,
  token: string,
  sessionId: string,
  body: { reviewers: Record<string, { status: string }> },
): Promise<void> {
  const post = async (event: "SubagentStart" | "SubagentStop", agentType: string) => {
    const res = await fetch(`${baseUrl}${SUBAGENT_HOOK_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", [RUN_TOKEN_HEADER]: token },
      body: JSON.stringify({
        hook_event_name: event,
        session_id: sessionId,
        agent_id: `${agentType}-${token.slice(0, 8)}`,
        agent_type: agentType,
      }),
    });
    if (!res.ok) throw new Error(`hook ${event} ${agentType}: ${res.status}`);
  };
  for (const [name, reviewer] of Object.entries(body.reviewers)) {
    if (reviewer.status !== "ran") continue;
    await post("SubagentStart", name);
    await post("SubagentStop", name);
  }
}

const slug = (taskId: string) => taskId.slice(0, 8);

/** Un commit real en el worktree: el trabajo de la tarea, distinto por iteración. */
function commitWork(worktree: string, taskId: string, iteration: number): string {
  const file = join(worktree, "work", `${slug(taskId)}.txt`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `trabajo de ${taskId}, iteración ${iteration}\n`, { flag: "a" });
  git(worktree, "add", "-A");
  git(
    worktree,
    "commit",
    "--quiet",
    "-m",
    `feat: trabajo de ${slug(taskId)} (iteración ${iteration})`,
  );
  return git(worktree, "rev-parse", "HEAD");
}

export interface AgentEnv {
  /** `http://127.0.0.1:<puerto>` del servidor de LunasQ. */
  baseUrl: string;
}

/** Un turno del agente: lo que hace entre que recibe un prompt y queda esperando. */
export async function runTurn(agent: PromptedAgent, env: AgentEnv): Promise<void> {
  const token = agent.env[RUN_ENV.runToken];
  const runId = agent.env[RUN_ENV.runId];
  const taskId = agent.env[RUN_ENV.taskId];
  const phase = agent.env[RUN_ENV.phase];
  if (!token || !runId || !taskId || !phase) {
    throw new Error(`el pane ${agent.paneId} no trae la identidad del Run`);
  }
  const sessionId = agent.args[agent.args.indexOf("--session-id") + 1] ?? runId;
  const ids = { taskId, runId };
  const mcp = await McpSession.open(env.baseUrl, token);
  try {
    const context = await mcp.call<Context>("get_task_context");
    const intent = context.task.intent;

    if (phase === "refine") {
      if (intent.includes("[pregunta]") && context.questions.length === 0) {
        await mcp.call("ask_human", {
          question: "¿La cancelación debe notificar al cliente por correo?",
          context: "El intent no lo dice y cambia los criterios de aceptación.",
        });
        return;
      }
      const answered = context.questions.find((q) => q.answer);
      const summary = answered
        ? `Spec con la respuesta del humano: ${answered.answer}`.slice(0, 280)
        : undefined;
      // El título es el intent: el piloto busca las tareas por ese texto en la UI.
      const refinement = handoff("refinement", ids, summary) as Json & { body: Json };
      refinement.body = { ...refinement.body, title: intent };
      await mcp.call("submit_spec", { handoff: refinement });
    } else if (phase === "implement") {
      const worktree = context.task.worktreePath ?? agent.cwd;
      const sha = commitWork(worktree, taskId, context.run.iteration);
      await mcp.call("update_checklist", { items: [{ taskId: "T-1", done: true }] });
      const implementation = handoff("implementation", ids) as Json & { body: Json };
      implementation.body = { ...implementation.body, commits: [sha] };
      await mcp.call("submit_for_verification", { handoff: implementation });
    } else if (phase === "verify") {
      const reject = intent.includes("[rework]") && context.verificationHistory.length === 0;
      const verdict = handoff(reject ? "verification-reject" : "verification-pass", ids) as Json & {
        body: { reviewers: Record<string, { status: string }> };
      };
      await reviewersRan(env.baseUrl, token, sessionId, verdict.body);
      await mcp.call("submit_verdict", { handoff: verdict });
    } else {
      throw new Error(`fase sin guion: ${phase}`);
    }
  } finally {
    await mcp.close();
  }
}
