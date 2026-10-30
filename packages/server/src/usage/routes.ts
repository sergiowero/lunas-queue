// Receptor OTLP/HTTP JSON del usage collector (ADR uw-20-usage-collector). Claude Code exporta aquí
// sus logs y métricas con el run token en el header (`OTEL_EXPORTER_OTLP_HEADERS` del pane). Como
// en los hooks de subagentes, un token desconocido responde {} sin efectos: el exportador
// reintenta lo que no es 2xx, y una sesión vieja no tiene nada que corregir.
import { gunzipSync } from "node:zlib";
import type { LunasqDatabase } from "@lunasq/db";
import { RunRepository, type RunRow, UsageRepository } from "@lunasq/db";
import {
  OTLP_LOGS_PATH,
  OTLP_METRICS_PATH,
  OtlpLogsRequest,
  RUN_TOKEN_HEADER,
} from "@lunasq/schemas";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { apiRequests } from "./otlp.ts";

export { OTLP_LOGS_PATH, OTLP_METRICS_PATH };

/** Tope del cuerpo recibido y, si viene en gzip, del descomprimido: un lote real pesa unos KB. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_DECODED_BYTES = 32 * 1024 * 1024;

async function jsonBody(request: Request): Promise<unknown> {
  const bytes = Buffer.from(await request.arrayBuffer());
  const encoded = request.headers.get("content-encoding")?.toLowerCase() === "gzip";
  const raw = encoded ? gunzipSync(bytes, { maxOutputLength: MAX_DECODED_BYTES }) : bytes;
  return JSON.parse(raw.toString("utf8"));
}

export function usageRoutes(db: LunasqDatabase): Hono<{ Variables: { run: RunRow } }> {
  const runs = new RunRepository(db);
  const usage = new UsageRepository(db);
  return new Hono<{ Variables: { run: RunRow } }>()
    .post(
      OTLP_LOGS_PATH,
      // El token se valida antes de leer el cuerpo: sin un Run válido no se paga ni la lectura.
      async (c, next) => {
        const token = c.req.header(RUN_TOKEN_HEADER);
        const run = token ? runs.byToken(token) : null;
        if (!run) return c.json({});
        c.set("run", run);
        await next();
      },
      bodyLimit({
        maxSize: MAX_BODY_BYTES,
        onError: (c) => c.json({ error: "payload_too_large" }, 413),
      }),
      async (c) => {
        const run = c.get("run");
        const body = await jsonBody(c.req.raw).catch(() => undefined);
        const parsed = OtlpLogsRequest.safeParse(body);
        if (!parsed.success) {
          return c.json({ error: "invalid_otlp", message: parsed.error.message }, 400);
        }
        // Solo cuenta lo que el pane declara de este Run y, con session id nativo fijado en el
        // claim, de su sesión: otro `claude` que herede el token no suma consumo al Run.
        const own = apiRequests(parsed.data).filter(
          (r) =>
            r.runId === run.id &&
            (run.agentSessionSource !== "native" || r.sessionId === run.agentSession),
        );
        usage.record(
          run.id,
          own.map((r) => r.usage),
        );
        return c.json({});
      },
    )
    .post(OTLP_METRICS_PATH, (c) => c.json({}));
}
