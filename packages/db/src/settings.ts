// Configuración global de LunasQ (docs/decisions/settings-proveedores.md): hoy, qué proveedores de
// agente puede usar el dispatcher. Una fila por clave; guardar es un upsert, así que repetir la
// misma configuración deja el mismo estado.
import {
  type Actor,
  AgentKind,
  AgentProviderSettings,
  SETTINGS_UPDATED,
  SettingsUpdatedPayload,
} from "@lunasq/schemas";
import { eq } from "drizzle-orm";
import type { LunasqDatabase } from "./client.ts";
import { appendEvent } from "./event-log.ts";
import { appSettings } from "./schema.ts";

const PROVIDERS_KEY = "providers";

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

export class SettingsRepository implements ProviderSettingsReader {
  private readonly db: LunasqDatabase;

  constructor(db: LunasqDatabase) {
    this.db = db;
  }

  providers(): AgentProviderSettings {
    return readProviderSettings(this.db);
  }

  /**
   * Guarda la configuración y publica settings.updated en la misma transacción. Idempotente: si
   * lo pedido ya es lo vigente no escribe ni publica, para no despertar al scheduler ni a la UI
   * sin un cambio real.
   */
  saveProviders(input: unknown, actor: Actor = "human"): AgentProviderSettings {
    const providers = AgentProviderSettings.parse(input);
    this.db.transaction((tx) => {
      const current = readProviderSettings(tx);
      if (AgentKind.options.every((kind) => current[kind] === providers[kind])) return;
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
    });
    return providers;
  }
}
