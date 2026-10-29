export const packageName = "@lunasq/adapters";

export type { GitContractHarness } from "./git/contract.ts";
export { GitError, type GitErrorCode, isGitError } from "./git/errors.ts";
export { FakeGit, type FakeTree } from "./git/fake.ts";
export { DEFAULT_FETCH_TIMEOUT_MS, RealGit, type RealGitOptions } from "./git/real.ts";
export type * from "./git/types.ts";
export type { GitHubContractHarness } from "./github/contract.ts";
export { GitHubError, type GitHubErrorCode, isGitHubError } from "./github/errors.ts";
export { FakeGitHub, type FakeGitHubOptions } from "./github/fake.ts";
export { RealGitHub, type RealGitHubOptions } from "./github/real.ts";
export type * from "./github/types.ts";
export {
  showsTrustDialog,
  TRUST_ACCEPT_KEYS,
  TRUST_DIALOG_MARKER,
} from "./herdr/claude-tui.ts";
export type { HerdrContractHarness } from "./herdr/contract.ts";
export { HerdrError, isHerdrError } from "./herdr/errors.ts";
export { FakeHerdr, type FakeHerdrOptions } from "./herdr/fake.ts";
export {
  defaultSocketPath,
  METADATA_SOURCE,
  RealHerdr,
  type RealHerdrOptions,
} from "./herdr/real.ts";
export type * from "./herdr/types.ts";
export { type FakeProcessHandler, FakeProcessRunner } from "./process/fake.ts";
export {
  HerdrPaneRunner,
  type HerdrPaneRunnerOptions,
  PANE_CLOSED_EXIT_CODE,
  PANE_TIMEOUT_EXIT_CODE,
} from "./process/pane.ts";
export {
  isProcessError,
  OUTPUT_LIMIT_BYTES,
  ProcessError,
  type ProcessErrorCode,
  ShellProcessRunner,
} from "./process/real.ts";
export type * from "./process/types.ts";
