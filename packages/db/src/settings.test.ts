import { SETTINGS_UPDATED } from "@lunasq/schemas";
import { describe, expect, it } from "vitest";
import { listPendingOutbox } from "./outbox.ts";
import { appSettings, events } from "./schema.ts";
import { SettingsRepository } from "./settings.ts";
import { migratedDatabase } from "./test-helpers.ts";

describe("SettingsRepository: agent providers", () => {
  it("a database with no saved configuration has every provider enabled", () => {
    const repo = new SettingsRepository(migratedDatabase());
    expect(repo.providers()).toEqual({ claude: true, copilot: true, codex: true });
  });

  it("saves the configuration and returns it on later reads", () => {
    const repo = new SettingsRepository(migratedDatabase());
    expect(repo.saveProviders({ claude: false, copilot: true })).toEqual({
      claude: false,
      copilot: true,
      codex: true,
    });
    expect(repo.providers()).toEqual({ claude: false, copilot: true, codex: true });
  });

  it("saving the same configuration twice leaves a single row and the same state", () => {
    const db = migratedDatabase();
    const repo = new SettingsRepository(db);
    repo.saveProviders({ claude: false, copilot: false, codex: false });
    repo.saveProviders({ claude: false, copilot: false, codex: false });
    expect(repo.providers()).toEqual({ claude: false, copilot: false, codex: false });
    expect(db.select().from(appSettings).all()).toHaveLength(1);
  });

  it("saving what is already in force does not publish another settings.updated", () => {
    const db = migratedDatabase();
    const repo = new SettingsRepository(db);
    repo.saveProviders({ claude: false, copilot: true, codex: true });
    repo.saveProviders({ claude: false, copilot: true, codex: true });
    expect(listPendingOutbox(db)).toHaveLength(1);
    expect(db.select().from(events).all()).toHaveLength(1);
    repo.saveProviders({ claude: true, copilot: true, codex: true });
    expect(listPendingOutbox(db)).toHaveLength(2);
  });

  it("a partial change keeps the other providers, even if another change is newer", () => {
    const db = migratedDatabase();
    const repo = new SettingsRepository(db);
    // Two clients with an old view: each one changes only its provider.
    repo.saveProviders({ claude: false });
    expect(repo.saveProviders({ copilot: false })).toEqual({
      claude: false,
      copilot: false,
      codex: true,
    });
    expect(repo.providers()).toEqual({ claude: false, copilot: false, codex: true });
    expect(repo.saveProviders({ copilot: true })).toEqual({
      claude: false,
      copilot: true,
      codex: true,
    });
    expect(listPendingOutbox(db)).toHaveLength(3);
  });

  it("saving the defaults without prior configuration publishes nothing", () => {
    const db = migratedDatabase();
    const repo = new SettingsRepository(db);
    repo.saveProviders({ claude: true, copilot: true, codex: true });
    expect(listPendingOutbox(db)).toEqual([]);
    expect(repo.providers()).toEqual({ claude: true, copilot: true, codex: true });
  });

  it("records settings.updated in the outbox with no associated task", () => {
    const db = migratedDatabase();
    new SettingsRepository(db).saveProviders({ claude: true, copilot: false }, "human");
    const [pending, ...rest] = listPendingOutbox(db);
    expect(rest).toEqual([]);
    expect(pending?.message).toMatchObject({
      topic: SETTINGS_UPDATED,
      taskId: null,
      actor: "human",
      payload: { providers: { claude: true, copilot: false, codex: true } },
    });
    expect(db.select().from(events).all()).toHaveLength(1);
  });

  it("a corrupt saved value is read as all enabled only for the missing fields", () => {
    const db = migratedDatabase();
    db.insert(appSettings)
      .values({ key: "providers", value: { copilot: false } })
      .run();
    expect(new SettingsRepository(db).providers()).toEqual({
      claude: true,
      copilot: false,
      codex: true,
    });
  });
});

describe("SettingsRepository: concurrency", () => {
  it("with no saved value it returns the default received", () => {
    const repo = new SettingsRepository(migratedDatabase());
    expect(repo.concurrency(5)).toEqual({ globalConcurrency: 5 });
    expect(repo.concurrency(8)).toEqual({ globalConcurrency: 8 });
  });

  it("saves the limit, returns it and publishes settings.updated with globalConcurrency", () => {
    const db = migratedDatabase();
    const repo = new SettingsRepository(db);
    expect(repo.saveConcurrency({ globalConcurrency: 2 })).toEqual({ globalConcurrency: 2 });
    expect(repo.concurrency(5)).toEqual({ globalConcurrency: 2 });
    const [pending, ...rest] = listPendingOutbox(db);
    expect(rest).toEqual([]);
    expect(pending?.message).toMatchObject({
      topic: SETTINGS_UPDATED,
      taskId: null,
      actor: "human",
      payload: { globalConcurrency: 2 },
    });
    expect(db.select().from(events).all()).toHaveLength(1);
  });

  it("saving the value in force neither writes nor publishes another event", () => {
    const db = migratedDatabase();
    const repo = new SettingsRepository(db);
    repo.saveConcurrency({ globalConcurrency: 2 });
    repo.saveConcurrency({ globalConcurrency: 2 });
    expect(listPendingOutbox(db)).toHaveLength(1);
    expect(db.select().from(events).all()).toHaveLength(1);
    expect(db.select().from(appSettings).all()).toHaveLength(1);
  });

  it("saving, with no prior value, the limit that already applies by default also publishes nothing", () => {
    const db = migratedDatabase();
    const repo = new SettingsRepository(db);
    repo.saveConcurrency({ globalConcurrency: 5 }, "human", 5);
    expect(listPendingOutbox(db)).toEqual([]);
    expect(db.select().from(appSettings).all()).toEqual([]);
  });

  it.each([[0], [51], [1.5], ["4"]])("rejects %s and keeps what was saved", (value) => {
    const db = migratedDatabase();
    const repo = new SettingsRepository(db);
    repo.saveConcurrency({ globalConcurrency: 3 });
    expect(() => repo.saveConcurrency({ globalConcurrency: value })).toThrow();
    expect(repo.concurrency(5)).toEqual({ globalConcurrency: 3 });
    expect(listPendingOutbox(db)).toHaveLength(1);
  });

  it("saving the limit does not touch the provider configuration", () => {
    const repo = new SettingsRepository(migratedDatabase());
    repo.saveProviders({ claude: false });
    repo.saveConcurrency({ globalConcurrency: 2 });
    expect(repo.providers()).toEqual({ claude: false, copilot: true, codex: true });
  });

  it("a corrupt saved value falls back to the default instead of breaking the read", () => {
    const db = migratedDatabase();
    db.insert(appSettings)
      .values({ key: "concurrency", value: { globalConcurrency: 0 } })
      .run();
    expect(new SettingsRepository(db).concurrency(5)).toEqual({ globalConcurrency: 5 });
  });
});
