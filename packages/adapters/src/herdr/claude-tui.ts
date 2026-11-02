// What LunasQ knows about Claude Code's TUI to operate it from herdr. It is external behavior,
// so it lives in adapters next to herdr's. Capture in spikes/herdr/outputs/09-agent-read-blocked.txt.

/** Option of the folder trust dialog that distinguishes it from other `blocked` (permissions). */
export const TRUST_DIALOG_MARKER = "Yes, I trust this folder";

/**
 * Keys that accept the dialog: the cursor starts on "No, exit", so a bare Enter
 * would close Claude Code (ADR 0004).
 */
export const TRUST_ACCEPT_KEYS = ["down", "enter"] as const;

/** Copilot's interactive workspace-trust dialog selects "1. Yes" by default. */
export const COPILOT_TRUST_ACCEPT_KEYS = ["enter"] as const;

/** Codex asks whether to trust the contents of a newly opened worktree. */
export const CODEX_TRUST_ACCEPT_KEYS = ["enter"] as const;

/** Whether the agent's screen shows the folder trust dialog. */
export function showsTrustDialog(screen: string): boolean {
  return screen.includes(TRUST_DIALOG_MARKER) && screen.includes("No, exit");
}

/** Whether Copilot CLI shows its interactive folder trust dialog. */
export function showsCopilotTrustDialog(screen: string): boolean {
  return (
    screen.includes("Confirm folder trust") &&
    screen.includes("Do you trust the files in this folder?") &&
    screen.includes("1. Yes")
  );
}

/** Whether Codex CLI shows its untrusted-directory prompt. */
export function showsCodexTrustDialog(screen: string): boolean {
  return (
    screen.includes("Do you trust the contents of this directory?") &&
    screen.includes("1. Yes, continue") &&
    screen.includes("2. No, quit")
  );
}

/**
 * The agent's TUI when usage runs out: the notice stays on screen and retrying is useless until
 * it resets. Texts seen from the CLI: `Usage limit reached · limit resets 3:45pm`,
 * `Usage limit reached · wrapping up`, `5-hour limit reached · resets <time>`, the footer of the
 * wait `Continuing automatically at 3:45pm · Esc to cancel` and the cutoff
 * `Automatic continue stopped after repeated usage-limit hits`. herdr does not know that UI (its
 * detection manifest has no rule for it), so LunasQ recognizes it here.
 */
export const USAGE_LIMIT_PATTERN = new RegExp(
  [
    "usage limit reached",
    "hit your usage limit",
    "usage-limit", // `Automatic continue stopped after repeated usage-limit hits`
    "(?:5-hour|weekly|session) limit (?:reached|resets)",
    "reached your (?:5-hour|weekly|session) limit",
    "limit(?: will)? resets? [^\\n]*?\\d{1,3}:\\d{2}", // `· limit resets 3:45pm`
    "limit will reset at ", // `Your limit will reset at 5pm (Asia/Tokyo)`
    "continuing automatically",
    "automatic continue",
  ].join("|"),
  "i",
);

/** Whether the agent's screen shows the usage-limit notice. */
export function showsUsageLimit(screen: string): boolean {
  return USAGE_LIMIT_PATTERN.test(screen);
}

/**
 * The notice as Claude draws it, for the escalation note: the last line that mentions it
 * with its contiguous run of at most three lines (the notice and its footer with the reset time).
 */
export function usageLimitMessage(screen: string): string {
  const lines = screen.split("\n").map((line) => line.trim());
  const idx = lines.reduce((last, line, i) => (USAGE_LIMIT_PATTERN.test(line) ? i : last), -1);
  if (idx === -1) return "usage limit reached";
  let start = idx;
  for (
    let steps = 0;
    steps < 2 && start > 0 && USAGE_LIMIT_PATTERN.test(lines[start - 1] ?? "");
    steps += 1
  )
    start -= 1;
  const message = lines
    .slice(start, idx + 1)
    .filter(Boolean)
    .join(" · ");
  return message.slice(0, 500) || "usage limit reached";
}
