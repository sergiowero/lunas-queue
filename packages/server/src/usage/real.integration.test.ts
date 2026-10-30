// El usage de una tarea contra Claude Code real (criterio de UW-20). No corre en `pnpm test`:
//   pnpm --filter @lunasq/server test:usage
// Levanta la app en un puerto local y abre `claude -p --output-format json` con el entorno de
// telemetría de un pane (`telemetryEnv` + `telemetryRunEnv`). Después compara el usage que LunasQ
// guardó con el `usage` y el `total_cost_usd` que Claude Code reporta en su resultado.
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskViewRepository } from "@lunasq/db";
import { insertProject, insertRun, insertTask, migratedDatabase } from "@lunasq/db/test-helpers";
import { telemetryRunEnv } from "@lunasq/domain";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import { telemetryEnv } from "../runtime/runtime.ts";
import { runClaude, serve } from "../test-helpers/real-claude.ts";

const enabled = process.env.LUNASQ_USAGE_INTEGRATION === "1";

describe.skipIf(!enabled)("usage contra Claude Code real", { timeout: 300_000 }, () => {
  let dir: string;
  let server: Server;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "lunasq-usage-"));
  });

  afterAll(async () => {
    await new Promise((resolve) => server?.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });

  it("el usage de la tarea coincide con los tokens y el costo que reporta Claude Code", async () => {
    const db = migratedDatabase();
    const sessionId = randomUUID();
    const task = insertTask(db, insertProject(db).id);
    const run = insertRun(db, task.id, {
      phase: "refine",
      agentSession: sessionId,
      agentSessionSource: "native",
    });
    server = await serve(createApp({ db }).fetch);
    const { port } = server.address() as AddressInfo;

    const output = await runClaude(
      dir,
      [
        "-p",
        "Responde solo con la palabra ok.",
        "--model",
        "haiku",
        "--output-format",
        "json",
        "--session-id",
        sessionId,
      ],
      {
        ...telemetryEnv(`http://127.0.0.1:${port}`),
        ...telemetryRunEnv({
          runToken: run.runToken,
          taskId: task.id,
          runId: run.id,
          phase: "refine",
        }),
        OTEL_LOGS_EXPORT_INTERVAL: "1000",
      },
    );
    const result = JSON.parse(output.slice(output.indexOf("{"))) as {
      total_cost_usd: number;
      usage: {
        input_tokens: number;
        output_tokens: number;
        cache_read_input_tokens: number;
        cache_creation_input_tokens: number;
      };
    };

    // Claude Code vacía su buffer de logs al salir; el lote puede llegar unos segundos después.
    const views = new TaskViewRepository(db);
    await vi.waitFor(() => expect(views.usage(task.id)?.total.outputTokens).toBeGreaterThan(0), {
      timeout: 30_000,
    });
    const total = views.usage(task.id)?.total;
    expect(total).toMatchObject({
      inputTokens: result.usage.input_tokens,
      outputTokens: result.usage.output_tokens,
      cacheReadTokens: result.usage.cache_read_input_tokens,
      cacheWriteTokens: result.usage.cache_creation_input_tokens,
    });
    expect(total?.costUsd).toBeCloseTo(result.total_cost_usd, 6);
  });
});
