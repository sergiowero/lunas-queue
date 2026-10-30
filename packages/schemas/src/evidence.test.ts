import { describe, expect, it } from "vitest";
import { COMMIT_TRAILER_RUN, COMMIT_TRAILER_TASK, EVIDENCE_DIR, evidencePath } from "./evidence.ts";

describe("archivo de evidencia", () => {
  it("vive en lunasq/tasks/{id}.md", () => {
    expect(EVIDENCE_DIR).toBe("lunasq/tasks");
    expect(evidencePath("abc")).toBe("lunasq/tasks/abc.md");
  });

  it("los commits llevan los trailers LunasQ-Task y LunasQ-Run", () => {
    expect([COMMIT_TRAILER_TASK, COMMIT_TRAILER_RUN]).toEqual(["LunasQ-Task", "LunasQ-Run"]);
  });
});
