import type { RunView } from "@lunasq/schemas";
import { describe, expect, it } from "vitest";
import type { Json } from "./api.ts";
import { eventRun, pendingPhase, runAt, specVersionRun } from "./attribution.ts";

let seq = 0;
function run(
  phase: Json<RunView>["phase"],
  startedAt: string,
  endedAt: string | null,
): Json<RunView> {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    taskId: "00000000-0000-4000-8000-0000000000ff",
    phase,
    agentKind: "claude",
    model: null,
    profileId: null,
    modelIndex: null,
    modelFailed: false,
    iteration: 0,
    herdrWorkspace: null,
    herdrPane: null,
    herdrName: null,
    agentSession: null,
    agentSessionSource: null,
    startedAt,
    endedAt,
    result: null,
    failureReason: null,
    handoff: null,
  };
}

const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();

describe("pendingPhase", () => {
  it("maps the states that await an agent to their phase and the rest to none", () => {
    expect(pendingPhase("draft")).toBe("refine");
    expect(pendingPhase("in_progress")).toBe("implement");
    expect(pendingPhase("verification")).toBe("verify");
    for (const state of ["refined", "needs_human", "paused", "completed"] as const) {
      expect(pendingPhase(state)).toBeNull();
    }
  });
});

describe("runAt", () => {
  const first = run("refine", at(0), at(10));
  const second = run("implement", at(20), null);

  it("finds the Run that was open at the instant, ended or still open", () => {
    expect(runAt([first, second], at(5))).toBe(first);
    expect(runAt([first, second], at(10))).toBe(first);
    expect(runAt([first, second], at(100))).toBe(second);
  });

  it("finds none between Runs or before the first", () => {
    expect(runAt([first, second], at(15))).toBeNull();
    expect(runAt([first, second], at(-5))).toBeNull();
    expect(runAt([], at(1))).toBeNull();
  });
});

describe("eventRun", () => {
  const open = run("implement", at(0), null);

  it("attributes only the events of the agent actor", () => {
    expect(eventRun([open], { actor: "agent", createdAt: at(5) })).toBe(open);
    expect(eventRun([open], { actor: "human", createdAt: at(5) })).toBeNull();
    expect(eventRun([open], { actor: "system", createdAt: at(5) })).toBeNull();
  });
});

describe("specVersionRun", () => {
  const refine1 = run("refine", at(0), at(10));
  const refine2 = run("refine", at(30), at(40));
  const implement = run("implement", at(50), null);

  it("attributes an agent version to the latest refine Run that started before it", () => {
    const runs = [refine1, refine2, implement];
    expect(specVersionRun(runs, { createdBy: "agent", createdAt: at(8) })).toBe(refine1);
    expect(specVersionRun(runs, { createdBy: "agent", createdAt: at(41) })).toBe(refine2);
    // An implement Run is never the author of a spec version.
    expect(specVersionRun(runs, { createdBy: "agent", createdAt: at(60) })).toBe(refine2);
  });

  it("attributes nothing to a human version or to one before any refine Run", () => {
    expect(specVersionRun([refine1], { createdBy: "human", createdAt: at(8) })).toBeNull();
    expect(specVersionRun([refine1], { createdBy: "agent", createdAt: at(-1) })).toBeNull();
  });
});
