import { describe, expect, it } from "vitest";
import { composeTitle } from "./document-title.ts";

describe("composeTitle", () => {
  it("joins the page and the app name, and prefixes the pending Inbox count", () => {
    expect(composeTitle("", 0)).toBe("LunasQ");
    expect(composeTitle("Cola global", 0)).toBe("Cola global — LunasQ");
    expect(composeTitle("#12 · Login", 3)).toBe("(3) #12 · Login — LunasQ");
  });
});
