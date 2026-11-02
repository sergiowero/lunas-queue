import { describe, expect, it } from "vitest";
import { TaskPrOpenedPayload, TaskPrStateChangedPayload } from "./pull-request.ts";

const url = "https://github.com/sergiowero/lunas-queue/pull/7";

describe("events of a task's PR", () => {
  it("task.pr_opened carries the URL and that of the previous PR", () => {
    expect(TaskPrOpenedPayload.parse({ url, previousUrl: null })).toEqual({
      url,
      previousUrl: null,
    });
    expect(() => TaskPrOpenedPayload.parse({ url: "no-es-url", previousUrl: null })).toThrow();
  });

  it("task.pr_state_changed only goes from open to merged or closed", () => {
    const at = "2026-10-29T17:54:13.000Z";
    expect(TaskPrStateChangedPayload.parse({ url, from: "open", to: "merged", at })).toEqual({
      url,
      from: "open",
      to: "merged",
      at,
    });
    expect(TaskPrStateChangedPayload.parse({ url, from: "open", to: "closed", at: null }).at).toBe(
      null,
    );
    expect(() => TaskPrStateChangedPayload.parse({ url, from: "open", to: "open", at })).toThrow();
    expect(() =>
      TaskPrStateChangedPayload.parse({ url, from: "merged", to: "closed", at }),
    ).toThrow();
  });
});
