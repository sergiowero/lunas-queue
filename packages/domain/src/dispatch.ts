// Reglas puras del despacho de una fase (docs/design.md §Secuencia de despacho y §Identidad de
// sesión por Run, ADR 0002, ADR uw-16-dispatcher): nombre del agente en herdr, entorno del pane,
// args de arranque, prompt de fase y qué identidad de sesión guarda el Run.
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

/** Nombres de agente que acepta herdr 0.9.5 (`api schema`). */
export const AGENT_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/** Dígitos del task id en el nombre: un UUID entero no cabe en 32 caracteres. */
const TASK_ID_DIGITS = 12;

/**
 * `t<12 hex del task id>-<fase>-<n>`, con `n` el ordinal del Run en esa fase. Determinístico: un
 * despacho que se retoma encuentra el mismo agente en vez de arrancar otro.
 */
export function agentName(taskId: string, phase: SchedulablePhase, ordinal: number): string {
  if (!Number.isInteger(ordinal) || ordinal < 1) {
    throw new DispatchRuleError(`ordinal de Run inválido: ${ordinal}`);
  }
  const digits = taskId.replaceAll("-", "").slice(0, TASK_ID_DIGITS);
  const name = `t${digits}-${phase}-${ordinal}`;
  if (!/^[A-Za-z0-9]+$/.test(digits) || !AGENT_NAME_PATTERN.test(name)) {
    throw new DispatchRuleError(`nombre de agente inválido para herdr: ${JSON.stringify(name)}`);
  }
  return name;
}

const AGENT_NAME_RE = new RegExp(
  `^t[A-Za-z0-9]{${TASK_ID_DIGITS}}-(refine|implement|verify)-([1-9][0-9]*)$`,
);

/** Si `name` tiene la forma de los agentes de LunasQ (`agentName`): sirve para hallar huérfanos. */
export function isAgentName(name: string): boolean {
  return AGENT_NAME_RE.test(name);
}

export type RunIdentity = {
  runToken: string;
  taskId: string;
  runId: string;
  phase: SchedulablePhase;
};

/** Entorno del pane del Run; `pane split --env` lo fija, `agent start` no lo acepta (ADR 0004). */
export function runEnv(run: RunIdentity): Record<string, string> {
  return {
    [RUN_ENV.runToken]: run.runToken,
    [RUN_ENV.taskId]: run.taskId,
    [RUN_ENV.runId]: run.runId,
    [RUN_ENV.phase]: run.phase,
  };
}

/**
 * Entorno OTLP propio de cada Run (ADR uw-20-usage-collector): los atributos de tarea, Run y fase
 * que Claude Code copia a cada log, y el run token como header con el que el usage collector
 * autentica y atribuye el consumo. Los ids y el token no llevan caracteres que escapar.
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

/** Prompt corto de fase: el contexto completo llega por MCP, no por el prompt. */
export function phasePrompt(phase: SchedulablePhase, taskId: string): string {
  return `Usa la skill ${PHASE_SKILL[phase]} para la tarea ${taskId} de LunasQ. Empieza llamando get_task_context del MCP lunasq y termina con su tool de salida.`;
}

/**
 * Nudge (docs/design.md §Señales): el agente se detuvo sin la señal MCP de fin de fase. Le
 * recuerda que la fase sigue abierta y cómo cerrarla.
 */
export function nudgePrompt(phase: SchedulablePhase, taskId: string): string {
  return `LunasQ: la fase ${phase} de la tarea ${taskId} sigue abierta. Si ya terminaste, llama la tool de salida de la skill ${PHASE_SKILL[phase]}; si no puedes seguir, usa report_failure o ask_human del MCP lunasq. Si no, continúa con la fase.`;
}

/**
 * Respuesta del humano a una Question (docs/design.md §Preguntas del agente y bloqueos): entra al
 * pane del agente vivo como prompt nuevo. Una sola línea, porque un salto de línea enviaría el
 * prompt a medias.
 */
export function answerPrompt(
  phase: SchedulablePhase,
  taskId: string,
  input: { question: string; answer: string },
): string {
  const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
  return `LunasQ: respuesta a tu pregunta de la tarea ${taskId}. Pregunta: "${oneLine(input.question)}". Respuesta: "${oneLine(input.answer)}". Continúa la fase ${phase} con la skill ${PHASE_SKILL[phase]} y cierra con su tool de salida.`;
}

export type SessionIdentity = { value: string; source: SessionSource };

/** Lo mejor disponible, en el orden del diseño: nativo, el de herdr, el nombre del agente. */
export function resolveSession(input: {
  nativeId?: string | null;
  herdr?: { value: string } | undefined;
  agentName: string;
}): SessionIdentity {
  if (input.nativeId) return { value: input.nativeId, source: "native" };
  if (input.herdr?.value) return { value: input.herdr.value, source: "herdr" };
  return { value: input.agentName, source: "name" };
}
