import { TASK_TITLE_MAX } from "@lunasq/schemas";
import { describe, expect, it } from "vitest";
import { es } from "./dictionary/es.ts";
import {
  BOARD_STATES,
  canPause,
  canResume,
  cappedTaskLabel,
  formatAgent,
  formatRelative,
  formatTimeout,
  fullLabelTitle,
} from "./format.ts";

describe("formatTimeout", () => {
  it("shows the configured timeout without rounding it", () => {
    expect(formatTimeout(30)).toBe("30 s");
    expect(formatTimeout(90)).toBe("90 s");
    expect(formatTimeout(150)).toBe("150 s");
    expect(formatTimeout(300)).toBe("5 min");
    expect(formatTimeout(600)).toBe("10 min");
  });
});

describe("formatAgent", () => {
  it("joins agentKind and model with a middle dot", () => {
    expect(formatAgent({ agentKind: "claude", model: "opus" })).toBe("claude · opus");
  });

  it("shows only the agentKind when there is no model", () => {
    expect(formatAgent({ agentKind: "claude", model: null })).toBe("claude");
  });
});

describe("pause", () => {
  it("Paused has a label and its board column", () => {
    expect(es.state.paused).toBe("Paused");
    expect(BOARD_STATES).toContain("paused");
  });

  it("draft, refined, in_progress and verification can be paused", () => {
    expect((["draft", "refined", "in_progress", "verification"] as const).every(canPause)).toBe(
      true,
    );
    for (const state of ["completed", "cancelled", "needs_human", "paused"] as const) {
      expect(canPause(state)).toBe(false);
    }
  });

  it("paused and needs_human are resumed", () => {
    expect(canResume("paused")).toBe(true);
    expect(canResume("needs_human")).toBe(true);
    for (const state of ["draft", "refined", "in_progress", "completed"] as const) {
      expect(canResume(state)).toBe(false);
    }
  });
});

describe("cappedTaskLabel", () => {
  const task = (title: string | null, goal: string) => ({ title, goal });

  it("leaves a label of exactly the cap unchanged", () => {
    const label = "a".repeat(TASK_TITLE_MAX);
    expect(cappedTaskLabel(task(label, "x"))).toBe(label);
  });

  it("keeps the first 69 characters plus «...» when the label is one character over the cap", () => {
    const capped = cappedTaskLabel(task("b".repeat(TASK_TITLE_MAX + 1), "x"));
    expect(capped).toBe(`${"b".repeat(69)}...`);
    expect(capped).toHaveLength(TASK_TITLE_MAX);
  });

  it("caps the goal while there is no title", () => {
    expect(cappedTaskLabel(task(null, "c".repeat(200)))).toBe(`${"c".repeat(69)}...`);
  });

  it("leaves a short title unchanged", () => {
    expect(cappedTaskLabel(task("Entrega lista", "x".repeat(200)))).toBe("Entrega lista");
  });

  it("does not split a character outside the BMP", () => {
    const capped = cappedTaskLabel(task(null, "😀".repeat(80)));
    expect(capped).toBe(`${"😀".repeat(69)}...`);
  });
});

describe("formatRelative", () => {
  const now = Date.parse("2026-11-27T12:00:00Z");
  const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();

  it("says now under a minute and uses the largest whole unit after that", () => {
    expect(formatRelative(ago(10), now)).toBe("ahora");
    expect(formatRelative(ago(3 * 60), now)).toBe("hace 3 min");
    expect(formatRelative(ago(2 * 3600 + 59), now)).toBe("hace 2 h");
    expect(formatRelative(ago(86_400), now)).toBe("ayer");
  });

  it("shows a dash without a date", () => {
    expect(formatRelative(null, now)).toBe("—");
  });
});

describe("fullLabelTitle", () => {
  it("returns the full label only when the list label was cut", () => {
    expect(fullLabelTitle({ title: null, goal: "Corto" })).toBeUndefined();
    const long = "x".repeat(TASK_TITLE_MAX + 10);
    expect(fullLabelTitle({ title: null, goal: long })).toBe(long);
  });
});
