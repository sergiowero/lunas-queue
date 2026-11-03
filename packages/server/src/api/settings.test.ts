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
  it("without saved configuration it returns all providers enabled", async () => {
    const { send } = setup();
    const res = await send("GET");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ claude: true, copilot: true, codex: true });
  });
});

describe("PUT /api/settings/providers", () => {
  it("saves the configuration, returns it and records settings.updated in the outbox", async () => {
    const { db, send } = setup();
    const res = await send("PUT", { claude: false, copilot: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ claude: false, copilot: true, codex: true });
    expect(await (await send("GET")).json()).toEqual({ claude: false, copilot: true, codex: true });
    expect(listPendingOutbox(db).map((e) => [e.message.topic, e.message.payload])).toEqual([
      [SETTINGS_UPDATED, { providers: { claude: false, copilot: true, codex: true } }],
    ]);
  });

  it("a partial PUT changes only the sent provider and keeps the other", async () => {
    const { send } = setup();
    await send("PUT", { claude: false });
    const res = await send("PUT", { copilot: false });
    expect(await res.json()).toEqual({ claude: false, copilot: false, codex: true });
    expect(await (await send("GET")).json()).toEqual({
      claude: false,
      copilot: false,
      codex: true,
    });
  });

  it("sending the same configuration twice leaves the same state and a single row", async () => {
    const { db, send } = setup();
    await send("PUT", { claude: false, copilot: false });
    await send("PUT", { claude: false, copilot: false });
    expect(await (await send("GET")).json()).toEqual({
      claude: false,
      copilot: false,
      codex: true,
    });
    expect(db.$client.prepare("select count(*) from app_settings").pluck().get()).toBe(1);
    expect(listPendingOutbox(db)).toHaveLength(1);
  });

  it.each([
    ["an unknown kind", { gemini: false }],
    ["a non-boolean value", { claude: "no" }],
    ["a body that is not an object", [true]],
  ])(
    "answers 400 invalid_input with %s and does not change what was saved",
    async (_name, body) => {
      const { db, send } = setup();
      new SettingsRepository(db).saveProviders({ claude: false, copilot: true, codex: true });
      const before = listPendingOutbox(db).length;
      const res = await send("PUT", body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_input" });
      expect(await (await send("GET")).json()).toEqual({
        claude: false,
        copilot: true,
        codex: true,
      });
      expect(listPendingOutbox(db)).toHaveLength(before);
    },
  );

  it("answers 400 invalid_json if the body is not JSON", async () => {
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
  it("without saved configuration it returns the default of 5", async () => {
    const { send } = concurrencySetup();
    const res = await send("GET");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ globalConcurrency: 5 });
  });

  it("without saved configuration it returns the server's SchedulerConfig limit", async () => {
    const { send } = concurrencySetup({ globalConcurrency: 8 });
    expect(await (await send("GET")).json()).toEqual({ globalConcurrency: 8 });
  });
});

describe("PUT /api/settings/concurrency", () => {
  it("saves the limit, returns it and records settings.updated in the outbox", async () => {
    const { db, send } = concurrencySetup();
    const res = await send("PUT", { globalConcurrency: 2 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ globalConcurrency: 2 });
    expect(await (await send("GET")).json()).toEqual({ globalConcurrency: 2 });
    expect(listPendingOutbox(db).map((e) => [e.message.topic, e.message.payload])).toEqual([
      [SETTINGS_UPDATED, { globalConcurrency: 2 }],
    ]);
  });

  it("sending the limit in force answers 200 and records no event", async () => {
    const { db, send } = concurrencySetup();
    await send("PUT", { globalConcurrency: 2 });
    const res = await send("PUT", { globalConcurrency: 2 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ globalConcurrency: 2 });
    expect(listPendingOutbox(db)).toHaveLength(1);
  });

  it("sending the default with nothing saved records no event", async () => {
    const { db, send } = concurrencySetup();
    expect((await send("PUT", { globalConcurrency: 5 })).status).toBe(200);
    expect(listPendingOutbox(db)).toEqual([]);
  });

  it.each([
    ["cero", { globalConcurrency: 0 }],
    ["more than 50", { globalConcurrency: 51 }],
    ["un decimal", { globalConcurrency: 1.5 }],
    ["a text", { globalConcurrency: "4" }],
    ["an unknown field", { globalConcurrency: 2, otro: true }],
    ["a body without the field", {}],
    ["a body that is not an object", [3]],
  ])(
    "answers 400 invalid_input with %s and does not change what was saved",
    async (_name, body) => {
      const { db, send } = concurrencySetup();
      new SettingsRepository(db).saveConcurrency({ globalConcurrency: 3 });
      const before = listPendingOutbox(db).length;
      const res = await send("PUT", body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_input" });
      expect(await (await send("GET")).json()).toEqual({ globalConcurrency: 3 });
      expect(listPendingOutbox(db)).toHaveLength(before);
    },
  );

  it("answers 400 invalid_json if the body is not JSON", async () => {
    const { db } = concurrencySetup();
    const res = await createApp({ db }).request("/api/settings/concurrency", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{no json",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_json" });
  });

  it("rejects the PUT with a foreign Host and does not change what was saved", async () => {
    const { db, send } = concurrencySetup();
    const res = await send("PUT", { globalConcurrency: 2 }, { host: "evil.example.com" });
    expect(res.status).toBe(403);
    expect(new SettingsRepository(db).concurrency(5)).toEqual({ globalConcurrency: 5 });
    expect(listPendingOutbox(db)).toEqual([]);
  });
});

function verificationSetup() {
  const db = migratedDatabase();
  const app = createApp({ db });
  const send = (
    method: string,
    body?: unknown,
    headers: Record<string, string> = {},
    peer?: string,
  ) =>
    app.request(
      "/api/settings/verification",
      {
        method,
        headers: { "content-type": "application/json", ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      peer === undefined ? undefined : { incoming: { socket: { remoteAddress: peer } } },
    );
  return { db, send };
}

describe("GET /api/settings/verification", () => {
  it("without a saved cap it returns the default of 5", async () => {
    const { send } = verificationSetup();
    const res = await send("GET");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ maxVerificationIterations: 5 });
  });

  it("returns the saved cap", async () => {
    const { db, send } = verificationSetup();
    new SettingsRepository(db).saveVerification({ maxVerificationIterations: 9 });
    expect(await (await send("GET")).json()).toEqual({ maxVerificationIterations: 9 });
  });
});

describe("PUT /api/settings/verification", () => {
  it("saves the cap, returns it and records settings.updated once", async () => {
    const { db, send } = verificationSetup();
    const res = await send("PUT", { maxVerificationIterations: 8 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ maxVerificationIterations: 8 });
    expect(await (await send("GET")).json()).toEqual({ maxVerificationIterations: 8 });
    expect(listPendingOutbox(db).map((e) => [e.message.topic, e.message.payload])).toEqual([
      [SETTINGS_UPDATED, { maxVerificationIterations: 8 }],
    ]);
  });

  it("sending the cap in force answers 200 and records no event", async () => {
    const { db, send } = verificationSetup();
    await send("PUT", { maxVerificationIterations: 8 });
    const res = await send("PUT", { maxVerificationIterations: 8 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ maxVerificationIterations: 8 });
    expect(listPendingOutbox(db)).toHaveLength(1);
  });

  it.each([
    ["zero", { maxVerificationIterations: 0 }],
    ["more than 20", { maxVerificationIterations: 21 }],
    ["a decimal", { maxVerificationIterations: 2.5 }],
    ["a text", { maxVerificationIterations: "4" }],
    ["an unknown field", { maxVerificationIterations: 2, other: true }],
    ["a body without the field", {}],
  ])("answers 400 invalid_input with %s and keeps what was saved", async (_name, body) => {
    const { db, send } = verificationSetup();
    new SettingsRepository(db).saveVerification({ maxVerificationIterations: 3 });
    const before = listPendingOutbox(db).length;
    const res = await send("PUT", body);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_input" });
    expect(await (await send("GET")).json()).toEqual({ maxVerificationIterations: 3 });
    expect(listPendingOutbox(db)).toHaveLength(before);
  });

  it("answers 400 invalid_json if the body is not JSON", async () => {
    const { db } = verificationSetup();
    const res = await createApp({ db }).request("/api/settings/verification", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{no json",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_json" });
  });

  it.each([
    ["a foreign Host", { host: "evil.example.com" }, undefined],
    ["a foreign Origin", { origin: "https://evil.example.com" }, undefined],
    ["a non-loopback socket", { host: "localhost" }, "192.168.1.20"],
  ])("answers 403 forbidden_origin to GET and PUT with %s", async (_name, headers, peer) => {
    const { db, send } = verificationSetup();
    const put = await send("PUT", { maxVerificationIterations: 2 }, headers, peer);
    expect(put.status).toBe(403);
    expect(await put.json()).toEqual({ error: "forbidden_origin" });
    const get = await send("GET", undefined, headers, peer);
    expect(get.status).toBe(403);
    expect(await get.json()).toEqual({ error: "forbidden_origin" });
    expect(new SettingsRepository(db).verification()).toEqual({ maxVerificationIterations: 5 });
    expect(listPendingOutbox(db)).toEqual([]);
  });
});

describe("request origin for /api/settings", () => {
  it.each([
    ["a Host that is not localhost (DNS rebinding)", { host: "evil.example.com" }],
    ["an Origin that is not localhost", { origin: "https://evil.example.com" }],
  ])("rejects the PUT with %s and does not change what was saved", async (_name, headers) => {
    const { db, send } = setup();
    const res = await send("PUT", { claude: false, copilot: false }, headers);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden_origin" });
    expect(new SettingsRepository(db).providers()).toEqual({
      claude: true,
      copilot: true,
      codex: true,
    });
    expect(listPendingOutbox(db)).toEqual([]);
  });

  it("also rejects the GET with a foreign Host", async () => {
    const { send } = setup();
    expect((await send("GET", undefined, { host: "evil.example.com:8123" })).status).toBe(403);
  });

  it.each([
    ["a local network IP", "192.168.1.20"],
    ["a foreign IPv6", "2001:db8::1"],
  ])("rejects the PUT from %s even if it forges Host: localhost", async (_name, remoteAddress) => {
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
    expect(new SettingsRepository(db).providers()).toEqual({
      claude: true,
      copilot: true,
      codex: true,
    });
    expect(listPendingOutbox(db)).toEqual([]);
  });

  it("accepts a loopback connection with a localhost Host", async () => {
    const { db } = setup();
    const app = createApp({ db });
    const res = await app.request(
      "/api/settings/providers",
      { method: "GET", headers: { host: "localhost:8123" } },
      { incoming: { socket: { remoteAddress: "::ffff:127.0.0.1" } } },
    );
    expect(res.status).toBe(200);
  });

  it("accepts localhost Host and Origin with a port", async () => {
    const { send } = setup();
    const res = await send(
      "PUT",
      { claude: false, copilot: true },
      { host: "127.0.0.1:8123", origin: "http://localhost:5173" },
    );
    expect(res.status).toBe(200);
  });
});
