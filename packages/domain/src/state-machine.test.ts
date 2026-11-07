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

// Command with all its guards green: this way the table below tests only state and sub-state.
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
  submit_result: { type: "submit_result", resultKind: "research" },
  verdict_rework: { type: "verdict_rework" },
  verdict_pass: {
    type: "verdict_pass",
    verifierPassed: true,
    testGatePassed: true,
    testsCoherent: true,
    allCriteriaPassed: true,
    prCreated: true,
  },
  delivery_conflict: { type: "delivery_conflict" },
  escalate: { type: "escalate", reason: "phase_timeout" },
  cancel: { type: "cancel" },
  pause: { type: "pause", deliveryInProgress: false },
  resume: { type: "resume", resumeTo: "in_progress" },
  dispatch: { type: "dispatch" },
  ask_human: { type: "ask_human" },
  answer: { type: "answer", agentAlive: true },
  run_failed: { type: "run_failed", attempt: 1 },
};
const COMMANDS = Object.keys(passing) as CommandInput["type"][];

const actorFor = (command: CommandInput["type"]): Actor => {
  const [actor] = COMMAND_ACTORS[command];
  if (!actor) throw new Error(`${command} without actor`);
  return actor;
};

const AGENT_STATES = ["draft", "in_progress", "verification"] as const;
const SUB_STATES = ["queued", "running", "waiting_human"] as const;

// The 14 coherent combinations of state and sub-state.
const SNAPSHOTS: [TaskState, SubState | null][] = [
  ...AGENT_STATES.flatMap((s) => SUB_STATES.map((sub): [TaskState, SubState] => [s, sub])),
  ["refined", null],
  ["completed", null],
  ["needs_human", null],
  ["paused", null],
  ["cancelled", null],
];

const key = (state: TaskState, sub: SubState | null) => `${state}/${sub ?? "-"}`;

// All the valid transitions: origin, command → destination. What is not here is rejected.
const VALID: Record<string, string> = {};
const add = (from: string, command: CommandInput["type"], to: string) => {
  VALID[`${from} ${command}`] = to;
};
add("draft/running", "submit_spec", "refined/-");
add("refined/-", "request_changes", "draft/queued");
add("refined/-", "approve", "in_progress/queued");
add("in_progress/running", "submit_for_verification", "verification/queued");
add("draft/running", "submit_result", "completed/-");
add("in_progress/running", "submit_result", "completed/-");
add("verification/running", "verdict_rework", "in_progress/queued");
add("verification/running", "verdict_pass", "completed/-");
add("verification/running", "delivery_conflict", "in_progress/queued");
add("completed/-", "delivery_conflict", "in_progress/queued");
add("needs_human/-", "resume", "in_progress/queued");
add("needs_human/-", "cancel", "cancelled/-");
add("paused/-", "resume", "in_progress/queued");
add("paused/-", "cancel", "cancelled/-");
add("refined/-", "pause", "paused/-");
add("refined/-", "escalate", "needs_human/-");
add("refined/-", "cancel", "cancelled/-");
for (const s of AGENT_STATES) {
  for (const sub of SUB_STATES) {
    add(`${s}/${sub}`, "escalate", "needs_human/-");
    add(`${s}/${sub}`, "cancel", "cancelled/-");
    add(`${s}/${sub}`, "pause", "paused/-");
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
  verificationCycleStart = 0,
): TaskSnapshot => ({ state, subState, verificationIteration, verificationCycleStart });

describe("transition: full table of states × commands", () => {
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

  it("the table covers the 14 combinations and the 16 commands", () => {
    expect(SNAPSHOTS).toHaveLength(14);
    expect(COMMANDS).toHaveLength(16);
    expect(Object.keys(VALID)).toHaveLength(56);
  });
});

describe("transition: inconsistent sub-state", () => {
  const incoherent: [TaskState, SubState | null][] = [
    ["draft", null],
    ["in_progress", null],
    ["refined", "queued"],
    ["completed", "running"],
    ["needs_human", "waiting_human"],
  ];
  for (const [state, sub] of incoherent) {
    it(`${key(state, sub)} rejects every command`, () => {
      for (const command of COMMANDS) {
        expect(transition(snap(state, sub), passing[command], actorFor(command))).toMatchObject({
          ok: false,
          error: { code: "invalid_transition" },
        });
      }
    });
  }

  it("rejects negative or non-integer iterations", () => {
    for (const iteration of [-1, 0.5, Number.NaN]) {
      expect(
        transition(snap("draft", "queued", iteration), passing.dispatch, "system"),
      ).toMatchObject({ ok: false, error: { code: "invalid_transition" } });
    }
  });
});

describe("transition: incoherent verification cycle start", () => {
  it("rejects a cycle start that is negative, non-integer or greater than the iteration", () => {
    for (const [iteration, cycleStart] of [
      [3, -1],
      [3, 0.5],
      [3, Number.NaN],
      [2, 3],
    ] as const) {
      expect(
        transition(snap("draft", "queued", iteration, cycleStart), passing.dispatch, "system"),
      ).toMatchObject({ ok: false, error: { code: "invalid_transition" } });
    }
  });
});

describe("transition: actors", () => {
  const ALL_ACTORS: Actor[] = ["human", "agent", "system"];
  const from: Record<CommandInput["type"], TaskSnapshot> = {
    submit_spec: snap("draft", "running"),
    request_changes: snap("refined", null),
    approve: snap("refined", null),
    submit_for_verification: snap("in_progress", "running"),
    verdict_rework: snap("verification", "running"),
    verdict_pass: snap("verification", "running"),
    delivery_conflict: snap("verification", "running"),
    escalate: snap("in_progress", "running"),
    cancel: snap("in_progress", "running"),
    pause: snap("in_progress", "running"),
    resume: snap("needs_human", null),
    dispatch: snap("draft", "queued"),
    ask_human: snap("draft", "running"),
    answer: snap("draft", "waiting_human"),
    run_failed: snap("draft", "running"),
    submit_result: snap("draft", "running"),
  };

  it("each command has the actors of the design", () => {
    expect(COMMAND_ACTORS).toEqual({
      submit_spec: ["agent"],
      request_changes: ["human"],
      approve: ["human"],
      submit_for_verification: ["agent"],
      submit_result: ["agent"],
      verdict_rework: ["agent"],
      verdict_pass: ["system"],
      delivery_conflict: ["system"],
      escalate: ["system"],
      cancel: ["human"],
      pause: ["human"],
      resume: ["human"],
      dispatch: ["system"],
      ask_human: ["agent"],
      answer: ["human"],
      run_failed: ["system"],
    });
  });

  for (const command of COMMANDS) {
    it(`${command} rejects disallowed actors`, () => {
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

  it("submit_spec requires a complete spec", () => {
    rejects(snap("draft", "running"), { type: "submit_spec", specComplete: false }, "agent");
  });

  it("request_changes requires comments from the human", () => {
    rejects(snap("refined", null), { type: "request_changes", hasComments: false }, "human");
  });

  it("approve requires an approved spec version", () => {
    rejects(snap("refined", null), { type: "approve", specApproved: false }, "human");
  });

  it("submit_for_verification requires a green gate, criteria with tests and commits", () => {
    for (const field of ["testGatePassed", "everyCriterionHasTest", "hasCommits"] as const) {
      rejects(
        snap("in_progress", "running"),
        { ...passing.submit_for_verification, [field]: false },
        "agent",
      );
    }
  });

  it("verdict_pass requires a verifier verdict, green gate, coherent tests, criteria at pass and PR", () => {
    for (const field of [
      "verifierPassed",
      "testGatePassed",
      "testsCoherent",
      "allCriteriaPassed",
      "prCreated",
    ] as const) {
      rejects(
        snap("verification", "running"),
        { ...passing.verdict_pass, [field]: false },
        "system",
      );
    }
  });

  it("resume only returns to a non-terminal state other than needs_human", () => {
    for (const resumeTo of ["completed", "cancelled", "needs_human"] as const) {
      rejects(snap("needs_human", null), { type: "resume", resumeTo }, "human");
    }
  });

  it("pause from verification is rejected while delivery is in progress", () => {
    rejects(snap("verification", "running"), { type: "pause", deliveryInProgress: true }, "human");
  });

  it("pause with delivery in progress is only rejected in verification", () => {
    expect(
      transition(
        snap("in_progress", "running"),
        { type: "pause", deliveryInProgress: true },
        "human",
      ),
    ).toMatchObject({ ok: true, next: snap("paused", null) });
  });

  it("the event must meet its schema: an empty or long note and a reason outside the enum are rejected", () => {
    const from = snap("in_progress", "running");
    rejects(from, { type: "escalate", reason: "blocked", note: "" }, "system");
    rejects(from, { type: "escalate", reason: "blocked", note: "x".repeat(2001) }, "system");
    rejects(from, { type: "escalate", reason: "boring" as never }, "system");
    rejects(snap("refined", null), { type: "cancel", note: "" }, "human");
  });

  it("run_failed requires a positive integer attempt", () => {
    for (const attempt of [0, -1, 1.5]) {
      rejects(snap("draft", "running"), { type: "run_failed", attempt }, "system");
    }
  });

  it("verdict_rework and run_failed require positive integer limits", () => {
    rejects(snap("verification", "running"), { type: "verdict_rework", maxIterations: 0 }, "agent");
    rejects(snap("draft", "running"), { type: "run_failed", attempt: 1, maxRetries: -1 }, "system");
  });
});

describe("transition: verification loop", () => {
  it("rework raises the iteration by one", () => {
    const result = transition(snap("verification", "running", 1), passing.verdict_rework, "agent");
    expect(result).toMatchObject({
      ok: true,
      next: { state: "in_progress", subState: "queued", verificationIteration: 2 },
    });
  });

  it(`with ${DEFAULT_MAX_ITERATIONS} iterations by default, the next rework goes to needs_human`, () => {
    expect(DEFAULT_MAX_ITERATIONS).toBe(5);
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
      next: snap("needs_human", null, DEFAULT_MAX_ITERATIONS),
      event: { payload: { command: "verdict_rework", reason: "iterations_exhausted" } },
    });
  });

  it("a resumed task keeps raising the cumulative iteration (AC-2, AC-3)", () => {
    expect(
      transition(snap("verification", "running", 3, 3), passing.verdict_rework, "agent"),
    ).toMatchObject({ ok: true, next: snap("in_progress", "queued", 4, 3) });
    expect(
      transition(snap("verification", "running", 5, 3), passing.verdict_rework, "agent"),
    ).toMatchObject({ ok: true, next: snap("in_progress", "queued", 6, 3) });
  });

  it("a resumed task escalates once its own cycle is spent, keeping the iteration (AC-4)", () => {
    expect(
      transition(
        snap("verification", "running", DEFAULT_MAX_ITERATIONS * 2, DEFAULT_MAX_ITERATIONS),
        passing.verdict_rework,
        "agent",
      ),
    ).toMatchObject({
      ok: true,
      next: snap("needs_human", null, DEFAULT_MAX_ITERATIONS * 2, DEFAULT_MAX_ITERATIONS),
      event: {
        payload: {
          reason: "iterations_exhausted",
          verificationIteration: DEFAULT_MAX_ITERATIONS * 2,
        },
      },
    });
  });

  it("a never-resumed task behaves as before at and below the maximum (AC-5)", () => {
    expect(
      transition(
        snap("verification", "running", DEFAULT_MAX_ITERATIONS - 1, 0),
        passing.verdict_rework,
        "agent",
      ),
    ).toMatchObject({ ok: true, next: snap("in_progress", "queued", DEFAULT_MAX_ITERATIONS, 0) });
    expect(
      transition(
        snap("verification", "running", DEFAULT_MAX_ITERATIONS, 0),
        passing.verdict_rework,
        "agent",
      ),
    ).toMatchObject({ ok: true, next: snap("needs_human", null, DEFAULT_MAX_ITERATIONS, 0) });
  });

  it("respects a configured maximum", () => {
    const result = transition(
      snap("verification", "running", 1),
      { type: "verdict_rework", maxIterations: 1 },
      "agent",
    );
    expect(result).toMatchObject({ ok: true, next: { state: "needs_human" } });
  });

  it("delivery_conflict returns to in progress without raising the iteration", () => {
    const result = transition(
      snap("verification", "running", 2),
      passing.delivery_conflict,
      "system",
    );
    expect(result).toMatchObject({ ok: true, next: snap("in_progress", "queued", 2) });
  });

  it("verdict_pass keeps the iteration", () => {
    const result = transition(snap("verification", "running", 2), passing.verdict_pass, "system");
    expect(result).toMatchObject({ ok: true, next: snap("completed", null, 2) });
  });
});

describe("transition: Run retries", () => {
  it(`up to ${DEFAULT_MAX_RETRIES} retries return to the queue; the next failure escalates`, () => {
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

describe("transition: human in the loop", () => {
  it("answer with the agent dead returns to the queue for a new Run", () => {
    expect(
      transition(snap("draft", "waiting_human"), { type: "answer", agentAlive: false }, "human"),
    ).toMatchObject({ ok: true, next: { state: "draft", subState: "queued" } });
  });

  it("escalate stores reason and note in the event", () => {
    const result = transition(
      snap("in_progress", "running", 1),
      { type: "escalate", reason: "blocked", note: "permission pending" },
      "system",
    );
    expect(result).toMatchObject({
      ok: true,
      next: snap("needs_human", null, 1),
      event: { payload: { reason: "blocked", note: "permission pending" } },
    });
  });

  it("resume returns to the indicated state with its initial sub-state and the same iteration", () => {
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

  it("resume with newCycle keeps the iteration and starts a new verification cycle at it (AC-1)", () => {
    expect(
      transition(
        snap("needs_human", null, 3),
        { type: "resume", resumeTo: "in_progress", newCycle: true },
        "human",
      ),
    ).toMatchObject({
      ok: true,
      next: snap("in_progress", "queued", 3, 3),
      event: { payload: { command: "resume", verificationIteration: 3 } },
    });
  });

  it("resume without newCycle keeps both the iteration and the cycle start (AC-6)", () => {
    expect(
      transition(snap("paused", null, 2, 0), { type: "resume", resumeTo: "in_progress" }, "human"),
    ).toMatchObject({ ok: true, next: snap("in_progress", "queued", 2, 0) });
    expect(
      transition(
        snap("needs_human", null, 5, 3),
        { type: "resume", resumeTo: "verification" },
        "human",
      ),
    ).toMatchObject({ ok: true, next: snap("verification", "queued", 5, 3) });
  });

  it("after newCycle, a rejection gets a full cycle of reworks before escalating again", () => {
    const resumed = transition(
      snap("needs_human", null, DEFAULT_MAX_ITERATIONS),
      { type: "resume", resumeTo: "verification", newCycle: true },
      "human",
    );
    if (!resumed.ok) throw new Error(resumed.error.message);
    const cycleStart = resumed.next.verificationCycleStart;
    expect(cycleStart).toBe(DEFAULT_MAX_ITERATIONS);
    let task = snap("verification", "running", resumed.next.verificationIteration, cycleStart);
    for (let i = 1; i <= DEFAULT_MAX_ITERATIONS; i++) {
      const result = transition(task, passing.verdict_rework, "agent");
      expect(result).toMatchObject({ ok: true, next: { state: "in_progress" } });
      task = snap("verification", "running", cycleStart + i, cycleStart);
    }
    expect(transition(task, passing.verdict_rework, "agent")).toMatchObject({
      ok: true,
      next: { state: "needs_human" },
    });
  });

  it.each([2, 7])(
    "after newCycle, a non-default cap of %i grants a full cycle of that size before escalating",
    (cap) => {
      const resumed = transition(
        snap("needs_human", null, cap),
        { type: "resume", resumeTo: "verification", newCycle: true },
        "human",
      );
      if (!resumed.ok) throw new Error(resumed.error.message);
      const cycleStart = resumed.next.verificationCycleStart;
      expect(cycleStart).toBe(cap);
      let task = snap("verification", "running", resumed.next.verificationIteration, cycleStart);
      for (let i = 1; i <= cap; i++) {
        const result = transition(task, { type: "verdict_rework", maxIterations: cap }, "agent");
        expect(result).toMatchObject({ ok: true, next: { state: "in_progress" } });
        task = snap("verification", "running", cycleStart + i, cycleStart);
      }
      expect(
        transition(task, { type: "verdict_rework", maxIterations: cap }, "agent"),
      ).toMatchObject({
        ok: true,
        next: { state: "needs_human" },
        event: { payload: { reason: "iterations_exhausted" } },
      });
    },
  );

  it("cancel stores the note in the event", () => {
    const result = transition(
      snap("refined", null),
      { type: "cancel", note: "no longer applies" },
      "human",
    );
    expect(result).toMatchObject({ ok: true, event: { payload: { note: "no longer applies" } } });
  });
});

describe("transition: pause", () => {
  const pausable: [TaskState, SubState | null][] = SNAPSHOTS.filter(([state]) =>
    ["draft", "refined", "in_progress", "verification"].includes(state),
  );

  it("pause leaves the task in paused without a sub-state, keeps the iteration and records the origin", () => {
    for (const [state, sub] of pausable) {
      const result = transition(snap(state, sub, 2), passing.pause, "human");
      expect(result).toMatchObject({
        ok: true,
        next: snap("paused", null, 2),
        event: {
          type: "task.transitioned",
          actor: "human",
          payload: {
            command: "pause",
            from: { state, subState: sub },
            to: { state: "paused", subState: null },
            verificationIteration: 2,
          },
        },
      });
    }
  });

  it("pause is rejected in completed, cancelled, needs_human and paused", () => {
    for (const state of ["completed", "cancelled", "needs_human", "paused"] as const) {
      expect(transition(snap(state, null), passing.pause, "human")).toMatchObject({
        ok: false,
        error: { code: "invalid_transition" },
      });
    }
  });

  it("pause by the system or the agent is rejected with actor_not_allowed", () => {
    for (const actor of ["system", "agent"] as const) {
      expect(transition(snap("in_progress", "running"), passing.pause, actor)).toMatchObject({
        ok: false,
        error: { code: "actor_not_allowed" },
      });
    }
  });

  it("resume from paused returns to in_progress/queued keeping the iteration", () => {
    expect(
      transition(snap("paused", null, 2), { type: "resume", resumeTo: "in_progress" }, "human"),
    ).toMatchObject({
      ok: true,
      next: snap("in_progress", "queued", 2),
      event: { payload: { command: "resume", from: { state: "paused", subState: null } } },
    });
  });

  it("resume from paused to refined leaves the sub-state at null", () => {
    expect(
      transition(snap("paused", null), { type: "resume", resumeTo: "refined" }, "human"),
    ).toMatchObject({ ok: true, next: snap("refined", null) });
  });

  it("cancel from paused leaves the task in cancelled", () => {
    expect(transition(snap("paused", null), { type: "cancel" }, "human")).toMatchObject({
      ok: true,
      next: snap("cancelled", null),
    });
  });

  it("a paused task rejects escalate and every command other than resume and cancel", () => {
    for (const command of COMMANDS) {
      if (command === "resume" || command === "cancel") continue;
      for (const actor of ["human", "agent", "system"] as const) {
        expect(transition(snap("paused", null), passing[command], actor).ok).toBe(false);
      }
    }
  });
});

describe("transition: submit_result", () => {
  it.each([
    ["draft", "research"],
    ["in_progress", "already_implemented"],
    ["in_progress", "not_resolvable"],
  ] as const)(
    "%s/running with type %s completes the task and leaves it in the event",
    (state, kind) => {
      const result = transition(
        snap(state, "running", 2),
        { type: "submit_result", resultKind: kind },
        "agent",
      );
      if (!result.ok) throw new Error(result.error.message);
      expect(result.next).toEqual(snap("completed", null, 2));
      expect(result.event.payload).toEqual({
        command: "submit_result",
        from: { state, subState: "running" },
        to: { state: "completed", subState: null },
        verificationIteration: 2,
        note: kind,
      });
    },
  );

  it.each([["queued"], ["waiting_human"]] as const)(
    "is rejected from a %s sub-state",
    (subState) => {
      const result = transition(
        snap("in_progress", subState),
        { type: "submit_result", resultKind: "research" },
        "agent",
      );
      expect(result).toMatchObject({ ok: false, error: { code: "invalid_transition" } });
    },
  );

  it("is rejected from verification, refined and completed", () => {
    for (const [state, sub] of [
      ["verification", "running"],
      ["refined", null],
      ["completed", null],
    ] as const) {
      const result = transition(
        snap(state, sub),
        { type: "submit_result", resultKind: "research" },
        "agent",
      );
      expect(result).toMatchObject({ ok: false, error: { code: "invalid_transition" } });
    }
  });

  it("is rejected with a non-agent actor", () => {
    for (const actor of ["human", "system"] as const) {
      const result = transition(
        snap("draft", "running"),
        { type: "submit_result", resultKind: "research" },
        actor,
      );
      expect(result).toMatchObject({ ok: false, error: { code: "actor_not_allowed" } });
    }
  });
});

describe("helpers", () => {
  it("subStateFor gives queued to states with an agent and null to the rest", () => {
    expect(subStateFor("draft")).toBe("queued");
    expect(subStateFor("in_progress")).toBe("queued");
    expect(subStateFor("verification")).toBe("queued");
    for (const s of ["refined", "completed", "needs_human", "paused", "cancelled"] as const) {
      expect(subStateFor(s)).toBeNull();
    }
  });

  it("completed and cancelled are terminal", () => {
    expect(isTerminal("completed")).toBe(true);
    expect(isTerminal("cancelled")).toBe(true);
    expect(isTerminal("needs_human")).toBe(false);
    expect(isTerminal("draft")).toBe(false);
  });
});
