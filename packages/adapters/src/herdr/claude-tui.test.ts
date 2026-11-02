import { describe, expect, it } from "vitest";
import {
  showsCodexTrustDialog,
  showsUsageLimit,
  TRUST_DIALOG_MARKER,
  USAGE_LIMIT_PATTERN,
  usageLimitMessage,
} from "./claude-tui.ts";

// Observed CLI screens (docs/design.md §Signals): the limit notice stays in the TUI and
// herdr does not detect it (its manifest has no rule for that UI), so LunasQ recognizes it here.
const WAIT_SCREEN =
  "Usage limit reached · limit resets 3:45pm\nContinuing automatically at 3:45pm · Esc to cancel";
const WRAP_UP_SCREEN = "trabajo en curso…\n❯ claude\nUsage limit reached · wrapping up";
const AGENTS_OWN_WORK = "❯ corrijo el bug de usage limit que quedó descrito en la tarea";
const TRUST_SCREEN = ` Quick safety check\n ${TRUST_DIALOG_MARKER}`;
const CODEX_TRUST_SCREEN =
  "You are in /worktree\nDo you trust the contents of this directory?\n› 1. Yes, continue\n  2. No, quit";

const withLimit: readonly string[] = [
  WAIT_SCREEN,
  WRAP_UP_SCREEN,
  "5-hour limit reached · resets 5pm",
  "You've reached your weekly limit. It resets wed at 8:00am",
  "You've hit your usage limit. Your limit will reset at 5pm (Asia/Tokyo)",
  "Now using credits. Your plan limit resets wed at 5:00pm",
  "Automatic continue stopped after repeated usage-limit hits · /rate-limit-options to try again",
];

const withoutLimit: readonly string[] = [
  AGENTS_OWN_WORK,
  "El plan tiene rate limits pero hoy no se alcanzó ninguno",
  TRUST_SCREEN,
];

describe("showsUsageLimit", () => {
  it("recognizes the usage-limit screens seen from the CLI", () => {
    for (const screen of withLimit) expect(showsUsageLimit(screen)).toBe(true);
  });

  it("does not flag the trust dialog or the agent's own work", () => {
    for (const screen of withoutLimit) expect(showsUsageLimit(screen)).toBe(false);
  });
});

describe("showsCodexTrustDialog", () => {
  it("recognizes Codex's untrusted-directory prompt but not ordinary blocked screens", () => {
    expect(showsCodexTrustDialog(CODEX_TRUST_SCREEN)).toBe(true);
    expect(showsCodexTrustDialog("Permission needed to run command?")).toBe(false);
  });
});

describe("usageLimitMessage", () => {
  it("returns the notice with its contiguous run of lines", () => {
    expect(usageLimitMessage(WAIT_SCREEN)).toBe(
      "Usage limit reached · limit resets 3:45pm · Continuing automatically at 3:45pm · Esc to cancel",
    );
  });

  it("without a notice returns the fallback", () => {
    expect(usageLimitMessage(AGENTS_OWN_WORK)).toBe("usage limit reached");
  });

  it("cuts at 500 characters", () => {
    const long = `${WRAP_UP_SCREEN}`.padEnd(600, "-");
    expect(usageLimitMessage(long).length).toBeLessThanOrEqual(500);
  });

  it("the pattern is the same to detect the screen and extract the message", () => {
    expect(showsUsageLimit(WRAP_UP_SCREEN)).toBe(USAGE_LIMIT_PATTERN.test(WRAP_UP_SCREEN));
  });
});
