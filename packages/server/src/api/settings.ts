// Settings routes (docs/decisions/settings-proveedores.md): which agent providers the dispatcher may use
// the global limit of concurrent agents and the global verification iteration cap. Validation lives in
// AgentProviderPatch, ConcurrencySettings and VerificationSettings; saving publishes settings.updated.
import type { SettingsRepository } from "@lunasq/db";
import { AgentProviderPatch, ConcurrencySettings, VerificationSettings } from "@lunasq/schemas";
import { Hono } from "hono";
import { invalidInput, localOriginOnly, readJson } from "./http.ts";

/** `defaultConcurrency` applies while Settings has not saved a limit (the SchedulerConfig one). */
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
    })
    .get("/verification", (c) => c.json(settings.verification()))
    .put("/verification", async (c) => {
      const json = await readJson(c);
      if (!json.ok) return c.json({ error: "invalid_json" }, 400);
      const input = VerificationSettings.safeParse(json.body);
      if (!input.success) return invalidInput(c, input.error);
      return c.json(settings.saveVerification(input.data));
    });
}
