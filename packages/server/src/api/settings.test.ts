import { listPendingOutbox, SettingsRepository } from "@lunasq/db";
import { migratedDatabase } from "@lunasq/db/test-helpers";
import { SETTINGS_UPDATED } from "@lunasq/schemas";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";

function setup() {
  const db = migratedDatabase();
  const app = createApp({ db });
  const send = (method: string, body?: unknown) =>
    app.request("/api/settings/providers", {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined
        ? {}
        : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
  return { db, send };
}

describe("GET /api/settings/providers", () => {
  it("sin configuración guardada devuelve claude y copilot habilitados", async () => {
    const { send } = setup();
    const res = await send("GET");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ claude: true, copilot: true });
  });
});

describe("PUT /api/settings/providers", () => {
  it("guarda la configuración, la devuelve y registra settings.updated en el outbox", async () => {
    const { db, send } = setup();
    const res = await send("PUT", { claude: false, copilot: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ claude: false, copilot: true });
    expect(await (await send("GET")).json()).toEqual({ claude: false, copilot: true });
    expect(listPendingOutbox(db).map((e) => [e.message.topic, e.message.payload])).toEqual([
      [SETTINGS_UPDATED, { providers: { claude: false, copilot: true } }],
    ]);
  });

  it("enviar la misma configuración dos veces deja el mismo estado y una sola fila", async () => {
    const { db, send } = setup();
    await send("PUT", { claude: false, copilot: false });
    await send("PUT", { claude: false, copilot: false });
    expect(await (await send("GET")).json()).toEqual({ claude: false, copilot: false });
    expect(db.$client.prepare("select count(*) from app_settings").pluck().get()).toBe(1);
  });

  it.each([
    ["un kind desconocido", { gemini: false }],
    ["un valor no booleano", { claude: "no" }],
    ["un cuerpo que no es objeto", [true]],
  ])("responde 400 invalid_input con %s y no cambia lo guardado", async (_name, body) => {
    const { db, send } = setup();
    new SettingsRepository(db).saveProviders({ claude: false, copilot: true });
    const before = listPendingOutbox(db).length;
    const res = await send("PUT", body);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_input" });
    expect(await (await send("GET")).json()).toEqual({ claude: false, copilot: true });
    expect(listPendingOutbox(db)).toHaveLength(before);
  });

  it("responde 400 invalid_json si el cuerpo no es JSON", async () => {
    const { send } = setup();
    const res = await send("PUT", "{no json");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_json" });
  });
});
