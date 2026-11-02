import { describe, expect, it } from "vitest";
import { withTrailers } from "./trailers.ts";

describe("withTrailers", () => {
  it("adds the trailers in their own paragraph", () => {
    expect(withTrailers("feat: algo\n", { "LunasQ-Task": "t1", "LunasQ-Run": "r1" })).toBe(
      "feat: algo\n\nLunasQ-Task: t1\nLunasQ-Run: r1\n",
    );
  });

  it("keeps the body and does not glue the trailers to the subject even if it has `: `", () => {
    expect(withTrailers("chore(x): algo\n\ncuerpo largo\n\n", { "LunasQ-Task": "t1" })).toBe(
      "chore(x): algo\n\ncuerpo largo\n\nLunasQ-Task: t1\n",
    );
  });

  it("adds to an existing trailer block", () => {
    expect(
      withTrailers("fix: algo\n\nSigned-off-by: Ana <a@x.dev>\n", { "LunasQ-Task": "t1" }),
    ).toBe("fix: algo\n\nSigned-off-by: Ana <a@x.dev>\nLunasQ-Task: t1\n");
  });

  it("does not repeat a key the commit already carries, even if the value differs", () => {
    const message = "fix: algo\n\nLunasQ-Task: t1\nLunasQ-Run: r1\n";
    expect(withTrailers(message, { "LunasQ-Task": "t1", "LunasQ-Run": "r2" })).toBe(message);
  });

  it("completes only the missing key", () => {
    expect(
      withTrailers("fix: algo\n\nLunasQ-Task: t1\n", { "LunasQ-Task": "t1", "LunasQ-Run": "r1" }),
    ).toBe("fix: algo\n\nLunasQ-Task: t1\nLunasQ-Run: r1\n");
  });

  it("without trailers returns the message as is", () => {
    expect(withTrailers("fix: algo\n", {})).toBe("fix: algo\n");
  });
});
