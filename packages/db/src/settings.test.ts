import { SETTINGS_UPDATED } from "@lunasq/schemas";
import { describe, expect, it } from "vitest";
import { listPendingOutbox } from "./outbox.ts";
import { appSettings, events } from "./schema.ts";
import { SettingsRepository } from "./settings.ts";
import { migratedDatabase } from "./test-helpers.ts";

describe("SettingsRepository: proveedores de agente", () => {
  it("una base sin configuración guardada tiene claude y copilot habilitados", () => {
    const repo = new SettingsRepository(migratedDatabase());
    expect(repo.providers()).toEqual({ claude: true, copilot: true });
  });

  it("guarda la configuración y la devuelve en lecturas posteriores", () => {
    const repo = new SettingsRepository(migratedDatabase());
    expect(repo.saveProviders({ claude: false, copilot: true })).toEqual({
      claude: false,
      copilot: true,
    });
    expect(repo.providers()).toEqual({ claude: false, copilot: true });
  });

  it("guardar la misma configuración dos veces deja una sola fila y el mismo estado", () => {
    const db = migratedDatabase();
    const repo = new SettingsRepository(db);
    repo.saveProviders({ claude: false, copilot: false });
    repo.saveProviders({ claude: false, copilot: false });
    expect(repo.providers()).toEqual({ claude: false, copilot: false });
    expect(db.select().from(appSettings).all()).toHaveLength(1);
  });

  it("guardar lo que ya está vigente no publica otro settings.updated", () => {
    const db = migratedDatabase();
    const repo = new SettingsRepository(db);
    repo.saveProviders({ claude: false, copilot: true });
    repo.saveProviders({ claude: false, copilot: true });
    expect(listPendingOutbox(db)).toHaveLength(1);
    expect(db.select().from(events).all()).toHaveLength(1);
    repo.saveProviders({ claude: true, copilot: true });
    expect(listPendingOutbox(db)).toHaveLength(2);
  });

  it("un cambio parcial conserva los demás proveedores, aunque otro cambio sea más nuevo", () => {
    const db = migratedDatabase();
    const repo = new SettingsRepository(db);
    // Dos clientes con una vista vieja: cada uno cambia solo su proveedor.
    repo.saveProviders({ claude: false });
    expect(repo.saveProviders({ copilot: false })).toEqual({ claude: false, copilot: false });
    expect(repo.providers()).toEqual({ claude: false, copilot: false });
    expect(repo.saveProviders({ copilot: true })).toEqual({ claude: false, copilot: true });
    expect(listPendingOutbox(db)).toHaveLength(3);
  });

  it("guardar los defaults sin configuración previa no publica nada", () => {
    const db = migratedDatabase();
    const repo = new SettingsRepository(db);
    repo.saveProviders({ claude: true, copilot: true });
    expect(listPendingOutbox(db)).toEqual([]);
    expect(repo.providers()).toEqual({ claude: true, copilot: true });
  });

  it("registra settings.updated en el outbox sin tarea asociada", () => {
    const db = migratedDatabase();
    new SettingsRepository(db).saveProviders({ claude: true, copilot: false }, "human");
    const [pending, ...rest] = listPendingOutbox(db);
    expect(rest).toEqual([]);
    expect(pending?.message).toMatchObject({
      topic: SETTINGS_UPDATED,
      taskId: null,
      actor: "human",
      payload: { providers: { claude: true, copilot: false } },
    });
    expect(db.select().from(events).all()).toHaveLength(1);
  });

  it("un valor guardado corrupto se lee como todos habilitados solo para los campos ausentes", () => {
    const db = migratedDatabase();
    db.insert(appSettings)
      .values({ key: "providers", value: { copilot: false } })
      .run();
    expect(new SettingsRepository(db).providers()).toEqual({ claude: true, copilot: false });
  });
});

describe("SettingsRepository: concurrencia", () => {
  it("sin valor guardado devuelve el default recibido", () => {
    const repo = new SettingsRepository(migratedDatabase());
    expect(repo.concurrency(5)).toEqual({ globalConcurrency: 5 });
    expect(repo.concurrency(8)).toEqual({ globalConcurrency: 8 });
  });

  it("guarda el límite, lo devuelve y publica settings.updated con globalConcurrency", () => {
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

  it("guardar el valor vigente no escribe ni publica otro evento", () => {
    const db = migratedDatabase();
    const repo = new SettingsRepository(db);
    repo.saveConcurrency({ globalConcurrency: 2 });
    repo.saveConcurrency({ globalConcurrency: 2 });
    expect(listPendingOutbox(db)).toHaveLength(1);
    expect(db.select().from(events).all()).toHaveLength(1);
    expect(db.select().from(appSettings).all()).toHaveLength(1);
  });

  it("guardar sin valor previo el límite que ya rige por default tampoco publica", () => {
    const db = migratedDatabase();
    const repo = new SettingsRepository(db);
    repo.saveConcurrency({ globalConcurrency: 5 }, "human", 5);
    expect(listPendingOutbox(db)).toEqual([]);
    expect(db.select().from(appSettings).all()).toEqual([]);
  });

  it.each([[0], [51], [1.5], ["4"]])("rechaza %s y conserva lo guardado", (value) => {
    const db = migratedDatabase();
    const repo = new SettingsRepository(db);
    repo.saveConcurrency({ globalConcurrency: 3 });
    expect(() => repo.saveConcurrency({ globalConcurrency: value })).toThrow();
    expect(repo.concurrency(5)).toEqual({ globalConcurrency: 3 });
    expect(listPendingOutbox(db)).toHaveLength(1);
  });

  it("guardar el límite no toca la configuración de proveedores", () => {
    const repo = new SettingsRepository(migratedDatabase());
    repo.saveProviders({ claude: false });
    repo.saveConcurrency({ globalConcurrency: 2 });
    expect(repo.providers()).toEqual({ claude: false, copilot: true });
  });

  it("un valor guardado corrupto cae al default en vez de romper la lectura", () => {
    const db = migratedDatabase();
    db.insert(appSettings)
      .values({ key: "concurrency", value: { globalConcurrency: 0 } })
      .run();
    expect(new SettingsRepository(db).concurrency(5)).toEqual({ globalConcurrency: 5 });
  });
});
