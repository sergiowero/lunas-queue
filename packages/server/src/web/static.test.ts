import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migratedDatabase } from "@lunasq/db/test-helpers";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "lunasq-web-"));
  dirs.push(root);
  writeFileSync(join(root, "index.html"), "<!doctype html><div id=root></div>");
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "assets", "app.js"), "console.log(1)");
  return createApp({ db: migratedDatabase(), webRoot: root });
}

describe("estáticos del front end", () => {
  it("sirve index.html en la raíz y los assets con su tipo", async () => {
    const app = setup();
    const index = await app.request("/");
    expect(index.status).toBe(200);
    expect(await index.text()).toContain("id=root");
    const asset = await app.request("/assets/app.js");
    expect(asset.headers.get("content-type")).toMatch(/javascript/);
  });

  it("responde index.html en rutas del cliente (fallback SPA)", async () => {
    const res = await setup().request("/tasks/abc");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
  });

  it("no tapa los 404 de la API ni de un asset faltante", async () => {
    const app = setup();
    const api = await app.request("/api/nada");
    expect(api.status).toBe(404);
    expect(api.headers.get("content-type")).not.toMatch(/text\/html/);
    expect((await app.request("/assets/falta.js")).status).toBe(404);
  });

  it("sin webRoot no sirve nada", async () => {
    const app = createApp({ db: migratedDatabase() });
    expect((await app.request("/")).status).toBe(404);
  });
});
