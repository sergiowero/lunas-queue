// Rutas de Settings (docs/decisions/settings-proveedores.md): qué proveedores de agente puede usar
// el dispatcher y el límite global de agentes concurrentes. La validación vive en
// AgentProviderPatch y ConcurrencySettings; guardar publica settings.updated.
import type { SettingsRepository } from "@lunasq/db";
import { AgentProviderPatch, ConcurrencySettings } from "@lunasq/schemas";
import { Hono } from "hono";
import { invalidInput, localOriginOnly, readJson } from "./http.ts";

/** `defaultConcurrency` rige mientras Settings no guarde un límite (el de SchedulerConfig). */
export function settingsRoutes(settings: SettingsRepository, defaultConcurrency: number): Hono {
  return new Hono()
    .use(localOriginOnly)
    .get("/providers", (c) => c.json(settings.providers()))
    .put("/providers", async (c) => {
      const json = await readJson(c);
      if (!json.ok) return c.json({ error: "invalid_json" }, 400);
      const input = AgentProviderPatch.safeParse(json.body);
      if (!input.success) return invalidInput(c, input.error);
      return c.json(settings.saveProviders(input.data));
    })
    .get("/concurrency", (c) => c.json(settings.concurrency(defaultConcurrency)))
    .put("/concurrency", async (c) => {
      const json = await readJson(c);
      if (!json.ok) return c.json({ error: "invalid_json" }, 400);
      const input = ConcurrencySettings.safeParse(json.body);
      if (!input.success) return invalidInput(c, input.error);
      return c.json(settings.saveConcurrency(input.data, "human", defaultConcurrency));
    });
}
