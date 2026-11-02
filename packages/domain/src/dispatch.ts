// Pure rules for dispatching a phase (docs/design.md §Dispatch sequence and §Session identity per
// Run, ADR 0002, ADR uw-16-dispatcher): agent name in herdr, pane environment,
// startup args, phase prompt and which session identity the Run keeps.
import {
  RESOURCE_ATTRIBUTES,
  RUN_ENV,
  RUN_TOKEN_HEADER,
  type SchedulablePhase,
  type SessionSource,
} from "@lunasq/schemas";

export class DispatchRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DispatchRuleError";
  }
}

/** Agent names accepted by herdr 0.9.5 (`api schema`). */
export const AGENT_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/** Digits of the task id in the name: a whole UUID does not fit in 32 characters. */
const TASK_ID_DIGITS = 12;

/**
 * `t<12 hex of the task id>-<phase>-<n>`, with `n` the ordinal of the Run in that phase. Deterministic: a
 * dispatch that is resumed finds the same agent instead of starting another.
 */
export function agentName(taskId: string, phase: SchedulablePhase, ordinal: number): string {
  if (!Number.isInteger(ordinal) || ordinal < 1) {
    throw new DispatchRuleError(`invalid Run ordinal: ${ordinal}`);
  }
  const digits = taskId.replaceAll("-", "").slice(0, TASK_ID_DIGITS);
  const name = `t${digits}-${phase}-${ordinal}`;
  if (!/^[A-Za-z0-9]+$/.test(digits) || !AGENT_NAME_PATTERN.test(name)) {
    throw new DispatchRuleError(`invalid agent name for herdr: ${JSON.stringify(name)}`);
  }
  return name;
}

const AGENT_NAME_RE = new RegExp(
  `^t[A-Za-z0-9]{${TASK_ID_DIGITS}}-(refine|implement|verify)-([1-9][0-9]*)$`,
);

/** Whether `name` has the form of LunasQ agents (`agentName`): used to find orphans. */
export function isAgentName(name: string): boolean {
  return AGENT_NAME_RE.test(name);
}

export type RunIdentity = {
  runToken: string;
  taskId: string;
  runId: string;
  phase: SchedulablePhase;
};

/** Environment of the Run pane; `pane split --env` sets it, `agent start` does not accept it (ADR 0004). */
export function runEnv(run: RunIdentity): Record<string, string> {
  return {
    [RUN_ENV.runToken]: run.runToken,
    [RUN_ENV.taskId]: run.taskId,
    [RUN_ENV.runId]: run.runId,
    [RUN_ENV.phase]: run.phase,
  };
}

/**
 * OTLP environment specific to each Run (ADR uw-20-usage-collector): the task, Run and phase attributes
 * that Claude Code copies to each log, and the run token as the header with which the usage collector
 * authenticates and attributes consumption. The ids and the token carry no characters to escape.
 */
export function telemetryRunEnv(run: RunIdentity): Record<string, string> {
  return {
    OTEL_RESOURCE_ATTRIBUTES: [
      `${RESOURCE_ATTRIBUTES.taskId}=${run.taskId}`,
      `${RESOURCE_ATTRIBUTES.runId}=${run.runId}`,
      `${RESOURCE_ATTRIBUTES.phase}=${run.phase}`,
    ].join(","),
    OTEL_EXPORTER_OTLP_HEADERS: `${RUN_TOKEN_HEADER}=${run.runToken}`,
  };
}

const PHASE_SKILL: Record<SchedulablePhase, string> = {
  refine: "refine-task",
  implement: "implement-task",
  verify: "verify-task",
};

/** Short phase prompt: the full context arrives through MCP, not through the prompt. */
export function phasePrompt(phase: SchedulablePhase, taskId: string): string {
  const noCodeExit =
    phase === "refine"
      ? " If the task is research or otherwise has no code deliverable, close it with submit_result and put the findings in its result."
      : "";
  return `Use the skill ${PHASE_SKILL[phase]} for LunasQ task ${taskId}. Start by calling get_task_context from the lunasq MCP and finish with its exit tool.${noCodeExit}`;
}

/**
 * Nudge (docs/design.md §Signals): the agent stopped without the MCP end-of-phase signal. It
 * reminds it that the phase is still open and how to close it.
 */
export function nudgePrompt(phase: SchedulablePhase, taskId: string): string {
  return `LunasQ: phase ${phase} of task ${taskId} is still open. If you are done, call the exit tool of the skill ${PHASE_SKILL[phase]}; if you cannot continue, use report_failure or ask_human from the lunasq MCP. Otherwise, continue with the phase.`;
}

/**
 * The human's answer to a Question (docs/design.md §Agent questions and blocks): it enters the
 * pane of the live agent as a new prompt. A single line, because a line break would send
 * prompt a medias.
 */
export function answerPrompt(
  phase: SchedulablePhase,
  taskId: string,
  input: { question: string; answer: string },
): string {
  const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
  return `LunasQ: answer to your question for task ${taskId}. Question: "${oneLine(input.question)}". Answer: "${oneLine(input.answer)}". Continue phase ${phase} with the skill ${PHASE_SKILL[phase]} and close with its exit tool.`;
}

export type SessionIdentity = { value: string; source: SessionSource };

/** The best available, in the order of the design: native, herdr's, the agent name. */
export function resolveSession(input: {
  nativeId?: string | null;
  herdr?: { value: string } | undefined;
  agentName: string;
}): SessionIdentity {
  if (input.nativeId) return { value: input.nativeId, source: "native" };
  if (input.herdr?.value) return { value: input.herdr.value, source: "herdr" };
  return { value: input.agentName, source: "name" };
}
