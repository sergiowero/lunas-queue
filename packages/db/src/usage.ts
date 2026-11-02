// UsageRecords written by the usage collector (docs/design.md §Usage, ADR uw-20-usage-collector).
// Ingestion is idempotent: Claude Code resends a batch if it does not receive the 2xx, and the same
// `source_ref` of a Run and a source is not stored twice (ADR 0005).
import type { UsageSource } from "@lunasq/schemas";
import type { LunasqDatabase } from "./client.ts";
import { usageRecords } from "./schema.ts";

export type UsageInput = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** USD estimated by the agent; null if it does not report it. */
  costUsd: number | null;
  source: UsageSource;
  /** Request id at the source; without it there is no deduplication. */
  sourceRef: string | null;
  /** Subagent that made the call; null for the main session. */
  agentId: string | null;
};

export class UsageRepository {
  private readonly db: LunasqDatabase;

  constructor(db: LunasqDatabase) {
    this.db = db;
  }

  /** Stores the Run's new records in a transaction and returns how many were new. */
  record(runId: string, inputs: UsageInput[]): number {
    if (inputs.length === 0) return 0;
    return this.db.transaction((tx) => {
      let inserted = 0;
      for (const input of inputs) {
        inserted += tx
          .insert(usageRecords)
          .values({ runId, ...input })
          .onConflictDoNothing()
          .returning({ id: usageRecords.id })
          .all().length;
      }
      return inserted;
    });
  }
}
