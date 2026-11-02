// OTLP/HTTP JSON receiver of the usage collector (ADR uw-20-usage-collector). Claude Code exports here
// its logs and metrics with the run token in the header (the pane's `OTEL_EXPORTER_OTLP_HEADERS`). As
// in the subagent hooks, an unknown token answers {} with no effects: the exporter
// retries what is not 2xx, and an old session has nothing to correct.
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

/** Cap on the received body and, if gzipped, on the decompressed one: a real batch weighs a few KB. */
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
      // The token is validated before reading the body: without a valid Run not even the read is paid for.
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
        // Only what the pane declares for this Run counts and, with the native session id fixed at the
        // claim, from its session: another `claude` that inherits the token adds no consumption to the Run.
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
