import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventStream } from "./socket.ts";
import type { HerdrEvent } from "./types.ts";

// Servidor NDJSON mínimo que imita el socket de herdr para `events.subscribe`.
class FakeSocketServer {
  readonly path: string;
  readonly requests: unknown[] = [];
  readonly clients: Socket[] = [];
  reply: (request: unknown) => string = () =>
    '{"id":"lunasq-events","result":{"type":"subscription_started"}}';
  private readonly server: Server;
  private readonly dir: string;

  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), "lunasq-sock-"));
    this.path = join(this.dir, "herdr.sock");
    this.server = createServer((client) => {
      this.clients.push(client);
      let buf = "";
      client.on("data", (chunk) => {
        buf += chunk.toString();
        const i = buf.indexOf("\n");
        if (i < 0) return;
        const request = JSON.parse(buf.slice(0, i));
        this.requests.push(request);
        client.write(`${this.reply(request)}\n`);
      });
      client.on("error", () => {});
    });
  }

  listen() {
    return new Promise<void>((resolve) => this.server.listen(this.path, resolve));
  }

  async close() {
    for (const c of this.clients) c.destroy();
    await new Promise((resolve) => this.server.close(resolve));
    rmSync(this.dir, { recursive: true, force: true });
  }

  get last() {
    const client = this.clients.at(-1);
    if (!client) throw new Error("sin clientes");
    return client;
  }
}

function recorder() {
  const events: HerdrEvent[] = [];
  const until = (pred: (events: HerdrEvent[]) => boolean) =>
    new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const tick = () => {
        if (pred(events)) resolve();
        else if (Date.now() - started > 2_000) reject(new Error(JSON.stringify(events)));
        else setTimeout(tick, 5);
      };
      tick();
    });
  return { events, onEvent: (e: HerdrEvent) => events.push(e), until };
}

const statusLine = (status: string) =>
  JSON.stringify({
    event: "pane.agent_status_changed",
    data: { agent: "claude", agent_status: status, pane_id: "w1:p2", workspace_id: "w1" },
  });

describe("EventStream", () => {
  let server: FakeSocketServer;
  const backoff = { initialMs: 10, maxMs: 40 };

  beforeEach(async () => {
    server = new FakeSocketServer();
    await server.listen();
  });

  afterEach(async () => {
    await server.close();
  });

  it("se suscribe y traduce eventos partidos entre chunks", async () => {
    const r = recorder();
    const subscriptions = [{ type: "pane.agent_status_changed", pane_id: "w1:p2" }];
    const stream = new EventStream({ socketPath: server.path, subscriptions, ...r, backoff });
    await r.until((e) => e.some((x) => x.type === "subscribed"));
    expect(server.requests).toEqual([
      { id: "lunasq-events", method: "events.subscribe", params: { subscriptions } },
    ]);

    const line = `${statusLine("working")}\n${statusLine("done")}\n`;
    server.last.write(line.slice(0, 30));
    server.last.write(line.slice(30));
    server.last.write(`${JSON.stringify({ event: "layout_updated", data: {} })}\n`);
    await r.until((e) => e.length === 3);
    expect(r.events).toEqual([
      { type: "subscribed" },
      { type: "agent_status_changed", paneId: "w1:p2", workspaceId: "w1", status: "working" },
      { type: "agent_status_changed", paneId: "w1:p2", workspaceId: "w1", status: "done" },
    ]);
    await stream.close();
  });

  it("un cierre del servidor emite events_lost una vez y reconecta", async () => {
    const r = recorder();
    const stream = new EventStream({ socketPath: server.path, subscriptions: [], ...r, backoff });
    await r.until((e) => e.length === 1);

    server.last.destroy();
    await r.until((e) => e.filter((x) => x.type === "subscribed").length === 2);
    expect(r.events.map((e) => e.type)).toEqual(["subscribed", "events_lost", "subscribed"]);
    expect(server.requests).toHaveLength(2);
    await stream.close();
  });

  it("mientras la re-suscripción falla reporta la pérdida una sola vez", async () => {
    const r = recorder();
    const stream = new EventStream({ socketPath: server.path, subscriptions: [], ...r, backoff });
    await r.until((e) => e.length === 1);
    let rejected = 0;
    server.reply = () => {
      rejected++;
      return "";
    };
    // El servidor acepta pero corta antes de confirmar la suscripción, varias veces.
    for (let i = 0; i < 3; i++) {
      const before = server.clients.length;
      server.last.destroy();
      await new Promise<void>((resolve) => {
        const tick = () => (server.clients.length > before ? resolve() : setTimeout(tick, 5));
        tick();
      });
    }
    expect(rejected).toBeGreaterThan(0);
    expect(r.events.filter((e) => e.type === "events_lost")).toHaveLength(1);

    server.reply = () => '{"id":"lunasq-events","result":{"type":"subscription_started"}}';
    server.last.destroy();
    await r.until((e) => e.filter((x) => x.type === "subscribed").length === 2);
    await stream.close();
  });

  it("si herdr no está al suscribirse reporta la pérdida y conecta cuando aparece", async () => {
    const late = new FakeSocketServer();
    const r = recorder();
    const stream = new EventStream({ socketPath: late.path, subscriptions: [], ...r, backoff });
    try {
      await r.until((e) => e.length === 1);
      expect(r.events).toEqual([{ type: "events_lost", reason: "stream closed" }]);
      await late.listen();
      await r.until((e) => e.some((x) => x.type === "subscribed"));
      expect(r.events.filter((e) => e.type === "events_lost")).toHaveLength(1);
    } finally {
      await stream.close();
      await late.close();
    }
  });

  it("una excepción del consumidor no tumba el proceso ni corta el stream", async () => {
    const errors: unknown[] = [];
    const seen: HerdrEvent[] = [];
    const onEvent = (e: HerdrEvent) => {
      seen.push(e);
      if (e.type === "subscribed") throw new Error("bug del consumidor");
    };
    const stream = new EventStream({
      socketPath: server.path,
      subscriptions: [],
      onEvent,
      onError: (err) => errors.push(err),
      backoff,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    server.last.write(`${statusLine("working")}\n`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(errors).toHaveLength(1);
    expect(seen.map((e) => e.type)).toEqual(["subscribed", "agent_status_changed"]);
    await stream.close();
  });

  it("un rechazo de herdr es terminal: subscription_failed y sin reintentos", async () => {
    server.reply = () =>
      '{"id":"lunasq-events","error":{"code":"pane_not_found","message":"pane w1:p9 not found"}}';
    const r = recorder();
    new EventStream({ socketPath: server.path, subscriptions: [], ...r, backoff });
    await r.until((e) => e.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(r.events).toEqual([
      { type: "subscription_failed", code: "pane_not_found", message: "pane w1:p9 not found" },
    ]);
    expect(server.requests).toHaveLength(1);
  });

  it("close() no emite events_lost ni reconecta", async () => {
    const r = recorder();
    const stream = new EventStream({ socketPath: server.path, subscriptions: [], ...r, backoff });
    await r.until((e) => e.length === 1);
    await stream.close();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(r.events).toEqual([{ type: "subscribed" }]);
    expect(server.requests).toHaveLength(1);
  });
});
