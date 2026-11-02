import { listPendingOutbox, SettingsRepository } from "@lunasq/db";
import { migratedDatabase } from "@lunasq/db/test-helpers";
import { SETTINGS_UPDATED } from "@lunasq/schemas";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";

function setup() {
  const db = migratedDatabase();
  const app = createApp({ db });
  const send = (method: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request("/api/settings/providers", {
      method,
      headers: { "content-type": "application/json", ...headers },
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

  it("un PUT parcial cambia solo el proveedor enviado y conserva el otro", async () => {
    const { send } = setup();
    await send("PUT", { claude: false });
    const res = await send("PUT", { copilot: false });
    expect(await res.json()).toEqual({ claude: false, copilot: false });
    expect(await (await send("GET")).json()).toEqual({ claude: false, copilot: false });
  });

  it("enviar la misma configuración dos veces deja el mismo estado y una sola fila", async () => {
    const { db, send } = setup();
    await send("PUT", { claude: false, copilot: false });
    await send("PUT", { claude: false, copilot: false });
    expect(await (await send("GET")).json()).toEqual({ claude: false, copilot: false });
    expect(db.$client.prepare("select count(*) from app_settings").pluck().get()).toBe(1);
    expect(listPendingOutbox(db)).toHaveLength(1);
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

function concurrencySetup(scheduler?: { globalConcurrency: number }) {
  const db = migratedDatabase();
  const app = createApp({ db, ...(scheduler && { scheduler }) });
  const send = (method: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request("/api/settings/concurrency", {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { db, send };
}

describe("GET /api/settings/concurrency", () => {
  it("sin configuración guardada devuelve el default de 5", async () => {
    const { send } = concurrencySetup();
    const res = await send("GET");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ globalConcurrency: 5 });
  });

  it("sin configuración guardada devuelve el límite de SchedulerConfig del servidor", async () => {
    const { send } = concurrencySetup({ globalConcurrency: 8 });
    expect(await (await send("GET")).json()).toEqual({ globalConcurrency: 8 });
  });
});

describe("PUT /api/settings/concurrency", () => {
  it("guarda el límite, lo devuelve y registra settings.updated en el outbox", async () => {
    const { db, send } = concurrencySetup();
    const res = await send("PUT", { globalConcurrency: 2 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ globalConcurrency: 2 });
    expect(await (await send("GET")).json()).toEqual({ globalConcurrency: 2 });
    expect(listPendingOutbox(db).map((e) => [e.message.topic, e.message.payload])).toEqual([
      [SETTINGS_UPDATED, { globalConcurrency: 2 }],
    ]);
  });

  it("enviar el límite vigente responde 200 y no registra ningún evento", async () => {
    const { db, send } = concurrencySetup();
    await send("PUT", { globalConcurrency: 2 });
    const res = await send("PUT", { globalConcurrency: 2 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ globalConcurrency: 2 });
    expect(listPendingOutbox(db)).toHaveLength(1);
  });

  it("enviar el default sin nada guardado no registra ningún evento", async () => {
    const { db, send } = concurrencySetup();
    expect((await send("PUT", { globalConcurrency: 5 })).status).toBe(200);
    expect(listPendingOutbox(db)).toEqual([]);
  });

  it.each([
    ["cero", { globalConcurrency: 0 }],
    ["más de 50", { globalConcurrency: 51 }],
    ["un decimal", { globalConcurrency: 1.5 }],
    ["un texto", { globalConcurrency: "4" }],
    ["un campo desconocido", { globalConcurrency: 2, otro: true }],
    ["un cuerpo sin el campo", {}],
    ["un cuerpo que no es objeto", [3]],
  ])("responde 400 invalid_input con %s y no cambia lo guardado", async (_name, body) => {
    const { db, send } = concurrencySetup();
    new SettingsRepository(db).saveConcurrency({ globalConcurrency: 3 });
    const before = listPendingOutbox(db).length;
    const res = await send("PUT", body);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_input" });
    expect(await (await send("GET")).json()).toEqual({ globalConcurrency: 3 });
    expect(listPendingOutbox(db)).toHaveLength(before);
  });

  it("responde 400 invalid_json si el cuerpo no es JSON", async () => {
    const { db } = concurrencySetup();
    const res = await createApp({ db }).request("/api/settings/concurrency", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{no json",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_json" });
  });

  it("rechaza el PUT con un Host ajeno y no cambia lo guardado", async () => {
    const { db, send } = concurrencySetup();
    const res = await send("PUT", { globalConcurrency: 2 }, { host: "evil.example.com" });
    expect(res.status).toBe(403);
    expect(new SettingsRepository(db).concurrency(5)).toEqual({ globalConcurrency: 5 });
    expect(listPendingOutbox(db)).toEqual([]);
  });
});

describe("origen de las peticiones a /api/settings", () => {
  it.each([
    ["un Host que no es localhost (DNS rebinding)", { host: "evil.example.com" }],
    ["un Origin que no es localhost", { origin: "https://evil.example.com" }],
  ])("rechaza el PUT con %s y no cambia lo guardado", async (_name, headers) => {
    const { db, send } = setup();
    const res = await send("PUT", { claude: false, copilot: false }, headers);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden_origin" });
    expect(new SettingsRepository(db).providers()).toEqual({ claude: true, copilot: true });
    expect(listPendingOutbox(db)).toEqual([]);
  });

  it("rechaza también el GET con un Host ajeno", async () => {
    const { send } = setup();
    expect((await send("GET", undefined, { host: "evil.example.com:8123" })).status).toBe(403);
  });

  it.each([
    ["una IP de la red local", "192.168.1.20"],
    ["una IPv6 ajena", "2001:db8::1"],
  ])("rechaza el PUT de %s aunque falsifique Host: localhost", async (_name, remoteAddress) => {
    const { db } = setup();
    const app = createApp({ db });
    const res = await app.request(
      "/api/settings/providers",
      {
        method: "PUT",
        headers: { "content-type": "application/json", host: "localhost" },
        body: JSON.stringify({ claude: false, copilot: false }),
      },
      { incoming: { socket: { remoteAddress } } },
    );
    expect(res.status).toBe(403);
    expect(new SettingsRepository(db).providers()).toEqual({ claude: true, copilot: true });
    expect(listPendingOutbox(db)).toEqual([]);
  });

  it("acepta una conexión loopback con Host de localhost", async () => {
    const { db } = setup();
    const app = createApp({ db });
    const res = await app.request(
      "/api/settings/providers",
      { method: "GET", headers: { host: "localhost:8123" } },
      { incoming: { socket: { remoteAddress: "::ffff:127.0.0.1" } } },
    );
    expect(res.status).toBe(200);
  });

  it("acepta Host y Origin de localhost con puerto", async () => {
    const { send } = setup();
    const res = await send(
      "PUT",
      { claude: false, copilot: true },
      { host: "127.0.0.1:8123", origin: "http://localhost:5173" },
    );
    expect(res.status).toBe(200);
  });
});
