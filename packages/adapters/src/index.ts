export const packageName = "@lunasq/adapters";

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
