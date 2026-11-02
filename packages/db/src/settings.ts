// LunasQ global configuration (docs/decisions/settings-proveedores.md): which agent
// providers the dispatcher may use and how many agents may live at once. One row per key;
// saving is an upsert, so repeating the same configuration leaves the same state.
import {
  type Actor,
  AgentKind,
  AgentProviderPatch,
  AgentProviderSettings,
  ConcurrencySettings,
  DEFAULT_GLOBAL_CONCURRENCY,
  SETTINGS_UPDATED,
  SettingsUpdatedPayload,
} from "@lunasq/schemas";
import { eq } from "drizzle-orm";
import type { LunasqDatabase } from "./client.ts";
import { appendEvent } from "./event-log.ts";
import { appSettings } from "./schema.ts";

const PROVIDERS_KEY = "providers";
const CONCURRENCY_KEY = "concurrency";

/** Read port for the enabled providers; scheduler and claim query it on each pass. */
export interface ProviderSettingsReader {
  providers(): AgentProviderSettings;
}

/** What was saved, completed with the defaults; without a row, all enabled. Accepts a transaction. */
export function readProviderSettings(db: Pick<LunasqDatabase, "select">): AgentProviderSettings {
  const row = db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, PROVIDERS_KEY))
    .get();
  return AgentProviderSettings.parse(row?.value ?? {});
}

/** Read port for the global concurrency limit; `fallback` applies when no value is saved. */
export interface ConcurrencySettingsReader {
  concurrency(fallback: number): ConcurrencySettings;
}

/**
 * The limit saved in Settings or, without a row (or with a value that no longer validates), `fallback`: the
 * SchedulerConfig default. Accepts a transaction, to revalidate inside the claim.
 */
export function readConcurrencySettings(
  db: Pick<LunasqDatabase, "select">,
  fallback: number,
): ConcurrencySettings {
  const row = db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, CONCURRENCY_KEY))
    .get();
  const stored = ConcurrencySettings.safeParse(row?.value);
  return stored.success ? stored.data : { globalConcurrency: fallback };
}

export class SettingsRepository implements ProviderSettingsReader, ConcurrencySettingsReader {
  private readonly db: LunasqDatabase;

  constructor(db: LunasqDatabase) {
    this.db = db;
  }

  providers(): AgentProviderSettings {
    return readProviderSettings(this.db);
  }

  concurrency(fallback: number = DEFAULT_GLOBAL_CONCURRENCY): ConcurrencySettings {
    return readConcurrencySettings(this.db, fallback);
  }

  /**
   * Saves the global limit and publishes settings.updated in the same transaction. Idempotent: if the
   * value is already in force (the saved one or, without a row, `fallback`) it neither writes nor publishes. Changing it
   * never touches Runs in progress; it only decides the following claims.
   */
  saveConcurrency(
    input: unknown,
    actor: Actor = "human",
    fallback: number = DEFAULT_GLOBAL_CONCURRENCY,
  ): ConcurrencySettings {
    const next = ConcurrencySettings.parse(input);
    return this.db.transaction((tx) => {
      const current = readConcurrencySettings(tx, fallback);
      if (current.globalConcurrency === next.globalConcurrency) return current;
      tx.insert(appSettings)
        .values({ key: CONCURRENCY_KEY, value: next })
        .onConflictDoUpdate({ target: appSettings.key, set: { value: next } })
        .run();
      appendEvent(
        tx,
        {
          taskId: null,
          type: SETTINGS_UPDATED,
          actor,
          payload: SettingsUpdatedPayload.parse({ globalConcurrency: next.globalConcurrency }),
        },
        { publish: true },
      );
      return next;
    });
  }

  /**
   * Applies a change (partial or complete) on top of what is in force and publishes settings.updated in the same
   * transaction; the providers the change does not name keep their value, so two
   * concurrent changes on different providers do not overwrite each other. Idempotent: if the result is already what is
   * in force it neither writes nor publishes, so as not to wake the scheduler or the UI without a real change.
   */
  saveProviders(input: unknown, actor: Actor = "human"): AgentProviderSettings {
    const patch = AgentProviderPatch.parse(input);
    return this.db.transaction((tx) => {
      const current = readProviderSettings(tx);
      const providers = AgentProviderSettings.parse({
        ...current,
        ...Object.fromEntries(Object.entries(patch).filter(([, enabled]) => enabled !== undefined)),
      });
      if (AgentKind.options.every((kind) => current[kind] === providers[kind])) return providers;
      tx.insert(appSettings)
        .values({ key: PROVIDERS_KEY, value: providers })
        .onConflictDoUpdate({ target: appSettings.key, set: { value: providers } })
        .run();
      appendEvent(
        tx,
        {
          taskId: null,
          type: SETTINGS_UPDATED,
          actor,
          payload: SettingsUpdatedPayload.parse({ providers }),
        },
        { publish: true },
      );
      return providers;
    });
  }
}
