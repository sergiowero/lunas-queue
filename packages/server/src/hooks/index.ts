export { type AfterMergeHooksOptions, subscribeAfterMergeHooks } from "./after-merge.ts";
export { type OnFailureHooksOptions, subscribeOnFailureHooks } from "./on-failure.ts";
export {
  HookError,
  type HookErrorCode,
  type HookExecution,
  type HookPointResult,
  HookService,
  type HookServiceDeps,
  isHookError,
  type ProjectHooks,
  type RunHooksInput,
} from "./service.ts";
