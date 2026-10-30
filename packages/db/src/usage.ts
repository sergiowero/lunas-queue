// UsageRecords que escribe el usage collector (docs/design.md §Consumo, ADR uw-20-usage-collector).
// La ingesta es idempotente: Claude Code reenvía un lote si no recibe el 2xx, y el mismo
// `source_ref` de un Run y una fuente no se guarda dos veces (ADR 0005).
import type { UsageSource } from "@lunasq/schemas";
import type { LunasqDatabase } from "./client.ts";
import { usageRecords } from "./schema.ts";

export type UsageInput = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** USD estimado por el agente; null si no lo reporta. */
  costUsd: number | null;
  source: UsageSource;
  /** Id del request en la fuente; sin él no se deduplica. */
  sourceRef: string | null;
  /** Subagente que hizo la llamada; null para la sesión principal. */
  agentId: string | null;
};

export class UsageRepository {
  private readonly db: LunasqDatabase;

  constructor(db: LunasqDatabase) {
    this.db = db;
  }

  /** Guarda los registros nuevos del Run en una transacción y devuelve cuántos eran nuevos. */
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
