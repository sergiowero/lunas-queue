// Subagent executions per Run (ADR uw-19-revisores): written by the Claude Code SubagentStart and
// SubagentStop hooks and UW-23 compares them with the reviewers the verdict reports.
// Both hooks are idempotent and the first one wins: repeating them does not move the times.
import { asc, eq, sql } from "drizzle-orm";
import type { LunasqDatabase } from "./client.ts";
import { runSubagents } from "./schema.ts";

export type RunSubagentRow = typeof runSubagents.$inferSelect;

export type SubagentRef = { agentId: string; agentType: string };

export class RunSubagentRepository {
  private readonly db: LunasqDatabase;

  constructor(db: LunasqDatabase) {
    this.db = db;
  }

  recordStart(runId: string, ref: SubagentRef): void {
    this.db
      .insert(runSubagents)
      .values({ runId, ...ref, startedAt: new Date() })
      .onConflictDoUpdate({
        target: [runSubagents.runId, runSubagents.agentId],
        set: { startedAt: sql`coalesce(${runSubagents.startedAt}, excluded.started_at)` },
      })
      .run();
  }

  recordStop(runId: string, ref: SubagentRef & { transcriptPath?: string | undefined }): void {
    const { transcriptPath, ...agent } = ref;
    this.db
      .insert(runSubagents)
      .values({ runId, ...agent, stoppedAt: new Date(), transcriptPath: transcriptPath ?? null })
      .onConflictDoUpdate({
        target: [runSubagents.runId, runSubagents.agentId],
        set: {
          stoppedAt: sql`coalesce(${runSubagents.stoppedAt}, excluded.stopped_at)`,
          transcriptPath: sql`case when ${runSubagents.stoppedAt} is null then excluded.transcript_path else ${runSubagents.transcriptPath} end`,
        },
      })
      .run();
  }

  /** In order of arrival of the first hook. */
  forRun(runId: string): RunSubagentRow[] {
    return this.db
      .select()
      .from(runSubagents)
      .where(eq(runSubagents.runId, runId))
      .orderBy(asc(sql`rowid`))
      .all();
  }
}
