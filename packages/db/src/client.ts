import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.ts";

export type LunasqDatabase = BetterSQLite3Database<typeof schema> & {
  $client: Database.Database;
};

/** Carpeta con las migraciones SQL generadas por drizzle-kit (`pnpm db:generate`). */
export const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

/** Abre la base en WAL, con llaves foráneas activas y espera ante bloqueos. */
export function openDatabase(path: string): LunasqDatabase {
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  return drizzle({ client: sqlite, schema });
}

/** Aplica las migraciones pendientes; repetirlo no tiene efecto. */
export function migrateDatabase(db: LunasqDatabase): void {
  migrate(db, { migrationsFolder });
}
