import type { SubState, TaskState } from "@lunasq/schemas";
import { describe, expect, it } from "vitest";
import { BOARD_STATES } from "./format.ts";
import { isInProgress } from "./in-progress.ts";

const SUB_STATES: Array<SubState | null> = ["queued", "running", "waiting_human", null];

describe("isInProgress", () => {
  it("es verdadera si y solo si el estado es in_progress o el sub-estado es running", () => {
    for (const state of BOARD_STATES as TaskState[]) {
      for (const subState of SUB_STATES) {
        expect(isInProgress({ state, subState }), `${state} / ${subState}`).toBe(
          state === "in_progress" || subState === "running",
        );
      }
    }
  });
});
