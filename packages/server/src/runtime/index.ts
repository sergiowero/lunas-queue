// El CLI solo depende de server (docs/tech-stack.md): sus comprobaciones de herramientas corren
// con el mismo runner de procesos.
export {
  FakeProcessRunner,
  type ProcessInput,
  type ProcessResult,
  type ProcessRunner,
  ShellProcessRunner,
} from "@lunasq/adapters";
export {
  DEFAULT_HOSTNAME,
  prepareDatabase,
  type Runtime,
  type RuntimeOptions,
  runtimeUrls,
  startRuntime,
  telemetryEnv,
} from "./runtime.ts";
