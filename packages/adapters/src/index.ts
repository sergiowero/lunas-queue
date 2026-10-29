export const packageName = "@lunasq/adapters";

export type { GitHubContractHarness } from "./github/contract.ts";
export { GitHubError, type GitHubErrorCode, isGitHubError } from "./github/errors.ts";
export { FakeGitHub, type FakeGitHubOptions } from "./github/fake.ts";
export { RealGitHub, type RealGitHubOptions } from "./github/real.ts";
export type * from "./github/types.ts";
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
  isProcessError,
  OUTPUT_LIMIT_BYTES,
  ProcessError,
  type ProcessErrorCode,
  ShellProcessRunner,
} from "./process/real.ts";
export type * from "./process/types.ts";
