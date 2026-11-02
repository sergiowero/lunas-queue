// Configuración global de LunasQ (docs/decisions/settings-proveedores.md): qué proveedores de
// agente puede usar el dispatcher y cuántos agentes pueden vivir a la vez. Una fila por clave;
// guardar es un upsert, así que repetir la misma configuración deja el mismo estado.
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

/** Puerto de lectura de los proveedores habilitados; scheduler y claim lo consultan por pasada. */
export interface ProviderSettingsReader {
  providers(): AgentProviderSettings;
}

/** Lo guardado, completado con los defaults; sin fila, todos habilitados. Acepta una transacción. */
export function readProviderSettings(db: Pick<LunasqDatabase, "select">): AgentProviderSettings {
  const row = db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, PROVIDERS_KEY))
    .get();
  return AgentProviderSettings.parse(row?.value ?? {});
}

/** Puerto de lectura del límite global de concurrencia; `fallback` rige sin valor guardado. */
export interface ConcurrencySettingsReader {
  concurrency(fallback: number): ConcurrencySettings;
}

/**
 * El límite guardado en Settings o, sin fila (o con un valor que ya no valida), `fallback`: el
 * default de SchedulerConfig. Acepta una transacción, para revalidar dentro del claim.
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
   * Guarda el límite global y publica settings.updated en la misma transacción. Idempotente: si el
   * valor ya es el vigente (el guardado o, sin fila, `fallback`) no escribe ni publica. Cambiarlo
   * nunca toca los Runs en curso; solo decide los claims siguientes.
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
   * Aplica un cambio (parcial o completo) sobre lo vigente y publica settings.updated en la misma
   * transacción; los proveedores que el cambio no nombra conservan su valor, así que dos cambios
   * concurrentes sobre proveedores distintos no se pisan. Idempotente: si el resultado ya es lo
   * vigente no escribe ni publica, para no despertar al scheduler ni a la UI sin un cambio real.
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
