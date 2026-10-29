import type { Actor, SubState, TaskState } from "@lunasq/schemas";
import { describe, expect, it } from "vitest";
import {
  COMMAND_ACTORS,
  type CommandInput,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_MAX_RETRIES,
  isTerminal,
  subStateFor,
  type TaskSnapshot,
  transition,
} from "./index.ts";

// Comando con todos sus guards en verde: así la tabla de abajo prueba solo estado y sub-estado.
const passing: { [K in CommandInput["type"]]: Extract<CommandInput, { type: K }> } = {
  submit_spec: { type: "submit_spec", specComplete: true },
  request_changes: { type: "request_changes", hasComments: true },
  approve: { type: "approve", specApproved: true },
  submit_for_verification: {
    type: "submit_for_verification",
    testGatePassed: true,
    everyCriterionHasTest: true,
    hasCommits: true,
  },
  verdict_rework: { type: "verdict_rework" },
  verdict_pass: {
    type: "verdict_pass",
    testGatePassed: true,
    testsCoherent: true,
    allCriteriaPassed: true,
    prCreated: true,
  },
  delivery_conflict: { type: "delivery_conflict" },
  escalate: { type: "escalate", reason: "phase_timeout" },
  cancel: { type: "cancel" },
  resume: { type: "resume", resumeTo: "in_progress" },
  dispatch: { type: "dispatch" },
  ask_human: { type: "ask_human" },
  answer: { type: "answer", agentAlive: true },
  run_failed: { type: "run_failed", attempt: 1 },
};
const COMMANDS = Object.keys(passing) as CommandInput["type"][];

const actorFor = (command: CommandInput["type"]): Actor => {
  const [actor] = COMMAND_ACTORS[command];
  if (!actor) throw new Error(`${command} sin actor`);
  return actor;
};

const AGENT_STATES = ["draft", "in_progress", "verification"] as const;
const SUB_STATES = ["queued", "running", "waiting_human"] as const;

// Las 13 combinaciones coherentes de estado y sub-estado.
const SNAPSHOTS: [TaskState, SubState | null][] = [
  ...AGENT_STATES.flatMap((s) => SUB_STATES.map((sub): [TaskState, SubState] => [s, sub])),
  ["refined", null],
  ["completed", null],
  ["needs_human", null],
  ["cancelled", null],
];

const key = (state: TaskState, sub: SubState | null) => `${state}/${sub ?? "-"}`;

// Todas las transiciones válidas: origen, comando → destino. Lo que no está aquí se rechaza.
const VALID: Record<string, string> = {};
const add = (from: string, command: CommandInput["type"], to: string) => {
  VALID[`${from} ${command}`] = to;
};
add("draft/running", "submit_spec", "refined/-");
add("refined/-", "request_changes", "draft/queued");
add("refined/-", "approve", "in_progress/queued");
add("in_progress/running", "submit_for_verification", "verification/queued");
add("verification/running", "verdict_rework", "in_progress/queued");
add("verification/running", "verdict_pass", "completed/-");
add("verification/queued", "verdict_pass", "completed/-");
add("verification/running", "delivery_conflict", "in_progress/queued");
add("verification/queued", "delivery_conflict", "in_progress/queued");
add("needs_human/-", "resume", "in_progress/queued");
add("needs_human/-", "cancel", "cancelled/-");
add("refined/-", "escalate", "needs_human/-");
add("refined/-", "cancel", "cancelled/-");
for (const s of AGENT_STATES) {
  for (const sub of SUB_STATES) {
    add(`${s}/${sub}`, "escalate", "needs_human/-");
    add(`${s}/${sub}`, "cancel", "cancelled/-");
  }
  add(`${s}/queued`, "dispatch", `${s}/running`);
  add(`${s}/running`, "ask_human", `${s}/waiting_human`);
  add(`${s}/waiting_human`, "answer", `${s}/running`);
  add(`${s}/running`, "run_failed", `${s}/queued`);
}

const snap = (
  state: TaskState,
  subState: SubState | null,
  verificationIteration = 0,
): TaskSnapshot => ({ state, subState, verificationIteration });

describe("transition: tabla completa de estados × comandos", () => {
  for (const [state, sub] of SNAPSHOTS) {
    for (const command of COMMANDS) {
      const expected = VALID[`${key(state, sub)} ${command}`];
      it(`${key(state, sub)} ${command} → ${expected ?? "rechazada"}`, () => {
        const result = transition(snap(state, sub), passing[command], actorFor(command));
        if (expected === undefined) {
          expect(result).toMatchObject({ ok: false, error: { code: "invalid_transition" } });
          return;
        }
        if (!result.ok) throw new Error(result.error.message);
        expect(key(result.next.state, result.next.subState)).toBe(expected);
        expect(result.event).toEqual({
          type: "task.transitioned",
          actor: actorFor(command),
          payload: expect.objectContaining({
            command,
            from: { state, subState: sub },
            to: { state: result.next.state, subState: result.next.subState },
            verificationIteration: result.next.verificationIteration,
          }),
        });
      });
    }
  }

  it("la tabla cubre las 13 combinaciones y los 14 comandos", () => {
    expect(SNAPSHOTS).toHaveLength(13);
    expect(COMMANDS).toHaveLength(14);
    expect(Object.keys(VALID)).toHaveLength(43);
  });
});

describe("transition: sub-estado incoherente", () => {
  const incoherent: [TaskState, SubState | null][] = [
    ["draft", null],
    ["in_progress", null],
    ["refined", "queued"],
    ["completed", "running"],
    ["needs_human", "waiting_human"],
  ];
  for (const [state, sub] of incoherent) {
    it(`${key(state, sub)} rechaza todos los comandos`, () => {
      for (const command of COMMANDS) {
        expect(transition(snap(state, sub), passing[command], actorFor(command))).toMatchObject({
          ok: false,
          error: { code: "invalid_transition" },
        });
      }
    });
  }

  it("rechaza iteraciones negativas o no enteras", () => {
    for (const iteration of [-1, 0.5, Number.NaN]) {
      expect(
        transition(snap("draft", "queued", iteration), passing.dispatch, "system"),
      ).toMatchObject({ ok: false, error: { code: "invalid_transition" } });
    }
  });
});

describe("transition: actores", () => {
  const ALL_ACTORS: Actor[] = ["human", "agent", "system"];
  const from: Record<CommandInput["type"], TaskSnapshot> = {
    submit_spec: snap("draft", "running"),
    request_changes: snap("refined", null),
    approve: snap("refined", null),
    submit_for_verification: snap("in_progress", "running"),
    verdict_rework: snap("verification", "running"),
    verdict_pass: snap("verification", "running"),
    delivery_conflict: snap("verification", "queued"),
    escalate: snap("in_progress", "running"),
    cancel: snap("in_progress", "running"),
    resume: snap("needs_human", null),
    dispatch: snap("draft", "queued"),
    ask_human: snap("draft", "running"),
    answer: snap("draft", "waiting_human"),
    run_failed: snap("draft", "running"),
  };

  it("cada comando tiene los actores del diseño", () => {
    expect(COMMAND_ACTORS).toEqual({
      submit_spec: ["agent"],
      request_changes: ["human"],
      approve: ["human"],
      submit_for_verification: ["agent"],
      verdict_rework: ["agent"],
      verdict_pass: ["agent", "system"],
      delivery_conflict: ["system"],
      escalate: ["system"],
      cancel: ["human"],
      resume: ["human"],
      dispatch: ["system"],
      ask_human: ["agent"],
      answer: ["human"],
      run_failed: ["system"],
    });
  });

  for (const command of COMMANDS) {
    it(`${command} rechaza actores no permitidos`, () => {
      for (const actor of ALL_ACTORS) {
        const result = transition(from[command], passing[command], actor);
        expect(result.ok).toBe(COMMAND_ACTORS[command].includes(actor));
        if (!result.ok) expect(result.error.code).toBe("actor_not_allowed");
      }
    });
  }
});

describe("transition: guards", () => {
  const rejects = (task: TaskSnapshot, command: CommandInput, actor: Actor) =>
    expect(transition(task, command, actor)).toMatchObject({
      ok: false,
      error: { code: "guard_failed" },
    });

  it("submit_spec exige spec completa", () => {
    rejects(snap("draft", "running"), { type: "submit_spec", specComplete: false }, "agent");
  });

  it("request_changes exige comentarios del humano", () => {
    rejects(snap("refined", null), { type: "request_changes", hasComments: false }, "human");
  });

  it("approve exige una versión de spec aprobada", () => {
    rejects(snap("refined", null), { type: "approve", specApproved: false }, "human");
  });

  it("submit_for_verification exige gate verde, criterios con test y commits", () => {
    for (const field of ["testGatePassed", "everyCriterionHasTest", "hasCommits"] as const) {
      rejects(
        snap("in_progress", "running"),
        { ...passing.submit_for_verification, [field]: false },
        "agent",
      );
    }
  });

  it("verdict_pass exige gate verde, tests coherentes, criterios en pass y PR", () => {
    for (const field of [
      "testGatePassed",
      "testsCoherent",
      "allCriteriaPassed",
      "prCreated",
    ] as const) {
      rejects(
        snap("verification", "running"),
        { ...passing.verdict_pass, [field]: false },
        "agent",
      );
    }
  });

  it("resume solo vuelve a un estado no terminal distinto de needs_human", () => {
    for (const resumeTo of ["completed", "cancelled", "needs_human"] as const) {
      rejects(snap("needs_human", null), { type: "resume", resumeTo }, "human");
    }
  });

  it("run_failed exige un intento entero positivo", () => {
    for (const attempt of [0, -1, 1.5]) {
      rejects(snap("draft", "running"), { type: "run_failed", attempt }, "system");
    }
  });

  it("verdict_rework y run_failed exigen límites enteros positivos", () => {
    rejects(snap("verification", "running"), { type: "verdict_rework", maxIterations: 0 }, "agent");
    rejects(snap("draft", "running"), { type: "run_failed", attempt: 1, maxRetries: -1 }, "system");
  });
});

describe("transition: loop de verificación", () => {
  it("rework sube la iteración en uno", () => {
    const result = transition(snap("verification", "running", 1), passing.verdict_rework, "agent");
    expect(result).toMatchObject({
      ok: true,
      next: { state: "in_progress", subState: "queued", verificationIteration: 2 },
    });
  });

  it(`con ${DEFAULT_MAX_ITERATIONS} iteraciones por defecto, la siguiente rework va a needs_human`, () => {
    expect(DEFAULT_MAX_ITERATIONS).toBe(3);
    let task = snap("verification", "running", 0);
    for (let i = 1; i <= DEFAULT_MAX_ITERATIONS; i++) {
      const result = transition(task, passing.verdict_rework, "agent");
      if (!result.ok) throw new Error(result.error.message);
      expect(result.next).toEqual(snap("in_progress", "queued", i));
      task = snap("verification", "running", i);
    }
    const exhausted = transition(task, passing.verdict_rework, "agent");
    expect(exhausted).toMatchObject({
      ok: true,
      next: snap("needs_human", null, 3),
      event: { payload: { command: "verdict_rework", reason: "iterations_exhausted" } },
    });
  });

  it("respeta un máximo configurado", () => {
    const result = transition(
      snap("verification", "running", 1),
      { type: "verdict_rework", maxIterations: 1 },
      "agent",
    );
    expect(result).toMatchObject({ ok: true, next: { state: "needs_human" } });
  });

  it("delivery_conflict regresa a in progress sin subir la iteración", () => {
    const result = transition(
      snap("verification", "queued", 2),
      passing.delivery_conflict,
      "system",
    );
    expect(result).toMatchObject({ ok: true, next: snap("in_progress", "queued", 2) });
  });

  it("verdict_pass conserva la iteración", () => {
    const result = transition(snap("verification", "running", 2), passing.verdict_pass, "agent");
    expect(result).toMatchObject({ ok: true, next: snap("completed", null, 2) });
  });
});

describe("transition: reintentos de Run", () => {
  it(`hasta ${DEFAULT_MAX_RETRIES} reintentos vuelven a la cola; el siguiente fallo escala`, () => {
    expect(DEFAULT_MAX_RETRIES).toBe(3);
    for (let attempt = 1; attempt <= DEFAULT_MAX_RETRIES; attempt++) {
      expect(
        transition(snap("in_progress", "running"), { type: "run_failed", attempt }, "system"),
      ).toMatchObject({ ok: true, next: { state: "in_progress", subState: "queued" } });
    }
    expect(
      transition(
        snap("in_progress", "running"),
        { type: "run_failed", attempt: DEFAULT_MAX_RETRIES + 1 },
        "system",
      ),
    ).toMatchObject({
      ok: true,
      next: { state: "needs_human", subState: null },
      event: { payload: { reason: "retries_exhausted" } },
    });
  });
});

describe("transition: humano en el loop", () => {
  it("answer con el agente muerto vuelve a la cola para un Run nuevo", () => {
    expect(
      transition(snap("draft", "waiting_human"), { type: "answer", agentAlive: false }, "human"),
    ).toMatchObject({ ok: true, next: { state: "draft", subState: "queued" } });
  });

  it("escalate guarda razón y nota en el evento", () => {
    const result = transition(
      snap("in_progress", "running", 1),
      { type: "escalate", reason: "blocked", note: "permiso pendiente" },
      "system",
    );
    expect(result).toMatchObject({
      ok: true,
      next: snap("needs_human", null, 1),
      event: { payload: { reason: "blocked", note: "permiso pendiente" } },
    });
  });

  it("resume vuelve al estado indicado con su sub-estado inicial y la misma iteración", () => {
    const cases: [TaskState, SubState | null][] = [
      ["draft", "queued"],
      ["refined", null],
      ["in_progress", "queued"],
      ["verification", "queued"],
    ];
    for (const [resumeTo, subState] of cases) {
      expect(
        transition(snap("needs_human", null, 2), { type: "resume", resumeTo }, "human"),
      ).toMatchObject({ ok: true, next: snap(resumeTo, subState, 2) });
    }
  });

  it("cancel guarda la nota en el evento", () => {
    const result = transition(
      snap("refined", null),
      { type: "cancel", note: "ya no aplica" },
      "human",
    );
    expect(result).toMatchObject({ ok: true, event: { payload: { note: "ya no aplica" } } });
  });
});

describe("helpers", () => {
  it("subStateFor da queued a los estados con agente y null al resto", () => {
    expect(subStateFor("draft")).toBe("queued");
    expect(subStateFor("in_progress")).toBe("queued");
    expect(subStateFor("verification")).toBe("queued");
    for (const s of ["refined", "completed", "needs_human", "cancelled"] as const) {
      expect(subStateFor(s)).toBeNull();
    }
  });

  it("completed y cancelled son terminales", () => {
    expect(isTerminal("completed")).toBe(true);
    expect(isTerminal("cancelled")).toBe(true);
    expect(isTerminal("needs_human")).toBe(false);
    expect(isTerminal("draft")).toBe(false);
  });
});
