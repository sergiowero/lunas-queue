// App-wide error handling: unexpected errors are logged, unknown API routes answer JSON.
import { migratedDatabase } from "@lunasq/db/test-helpers";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.ts";

describe("createApp errors", () => {
  it("an unexpected error answers 500 internal and logs its stack", async () => {
    const logs: string[] = [];
    const app = createApp({
      db: migratedDatabase(),
      blocked: () => {
        throw new Error("boom");
      },
      log: (message) => logs.push(message),
    });
    const res = await app.request("/api/blocked");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal" });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^api: GET \/api\/blocked: Error: boom\n\s+at /);
  });

  it("an unknown API route answers 404 in JSON", async () => {
    const app = createApp({ db: migratedDatabase() });
    const res = await app.request("/api/nothing-here", { method: "POST" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "not_found",
      message: "no route for POST /api/nothing-here",
    });
  });

  it("a missing resource names what was not found", async () => {
    const app = createApp({ db: migratedDatabase() });
    const id = "00000000-0000-4000-8000-000000000999";
    const res = await app.request(`/api/tasks/${id}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found", message: `task ${id} not found` });
  });

  it("an invalid JSON body answers invalid_json with a message", async () => {
    const app = createApp({ db: migratedDatabase() });
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{no",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "invalid_json",
      message: "the request body is not valid JSON",
    });
  });
});
