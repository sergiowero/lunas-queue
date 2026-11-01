// Rutas de Settings (docs/decisions/settings-proveedores.md): qué proveedores de agente puede usar
// el dispatcher. La validación vive en AgentProviderSettings; guardar publica settings.updated.
import type { SettingsRepository } from "@lunasq/db";
import { AgentProviderSettings } from "@lunasq/schemas";
import { Hono } from "hono";
import { invalidInput, readJson } from "./http.ts";

export function settingsRoutes(settings: SettingsRepository): Hono {
  return new Hono()
    .get("/providers", (c) => c.json(settings.providers()))
    .put("/providers", async (c) => {
      const json = await readJson(c);
      if (!json.ok) return c.json({ error: "invalid_json" }, 400);
      const input = AgentProviderSettings.safeParse(json.body);
      if (!input.success) return invalidInput(c, input.error);
      return c.json(settings.saveProviders(input.data));
    });
}
