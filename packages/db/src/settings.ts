// Configuración global de LunasQ (docs/decisions/settings-proveedores.md): hoy, qué proveedores de
// agente puede usar el dispatcher. Una fila por clave; guardar es un upsert, así que repetir la
// misma configuración deja el mismo estado.
import {
  type Actor,
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

export class SettingsRepository implements ProviderSettingsReader {
  private readonly db: LunasqDatabase;

  constructor(db: LunasqDatabase) {
    this.db = db;
  }

  /** Lo guardado, completado con los defaults; sin fila, todos habilitados. */
  providers(): AgentProviderSettings {
    const row = this.db
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, PROVIDERS_KEY))
      .get();
    return AgentProviderSettings.parse(row?.value ?? {});
  }

  /** Guarda la configuración y publica settings.updated en la misma transacción. */
  saveProviders(input: unknown, actor: Actor = "human"): AgentProviderSettings {
    const providers = AgentProviderSettings.parse(input);
    this.db.transaction((tx) => {
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
