// Archivo de settings estable con los hooks SubagentStart y SubagentStop (docs/design.md
// §Verificación con subagentes, ADR uw-19-revisores). Son hooks `http` hacia el endpoint de
// LunasQ; el run token va en el header como `$LUNASQ_RUN_TOKEN`, que Claude Code expande del
// entorno del pane solo porque está en `allowedEnvVars`. El token nunca toca disco (ADR 0002).
import { RUN_ENV, RUN_TOKEN_HEADER } from "@lunasq/schemas";
import { ensureJsonFile } from "./stable-file.ts";

/** Segundos que Claude Code espera la respuesta del hook; el endpoint solo escribe una fila. */
const HOOK_TIMEOUT_SECONDS = 10;

export function hookSettings(url: string) {
  const hook = {
    type: "http",
    url,
    headers: { [RUN_TOKEN_HEADER]: `$${RUN_ENV.runToken}` },
    allowedEnvVars: [RUN_ENV.runToken],
    timeout: HOOK_TIMEOUT_SECONDS,
  };
  return {
    hooks: {
      SubagentStart: [{ hooks: [hook] }],
      SubagentStop: [{ hooks: [hook] }],
    },
  };
}

/** Escribe el archivo solo si falta o cambió; idempotente. */
export function ensureHookSettings(path: string, url: string): Promise<{ written: boolean }> {
  return ensureJsonFile(path, hookSettings(url));
}
