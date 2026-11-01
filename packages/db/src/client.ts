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

/**
 * Aplica las migraciones pendientes; repetirlo no tiene efecto.
 *
 * Las llaves foráneas se apagan mientras corre: drizzle ejecuta cada migración en una transacción,
 * donde `PRAGMA foreign_keys=OFF` no actúa, y las que recrean una tabla padre (0010 con `tasks`)
 * borrarían en cascada a sus hijos. Es el procedimiento de SQLite para cambiar un esquema; al
 * terminar se verifica que no queden filas huérfanas.
 */
export function migrateDatabase(db: LunasqDatabase): void {
  const sqlite = db.$client;
  const foreignKeys = sqlite.pragma("foreign_keys", { simple: true }) === 1;
  sqlite.pragma("foreign_keys = OFF");
  try {
    migrate(db, { migrationsFolder });
    const violations = sqlite.pragma("foreign_key_check") as unknown[];
    if (violations.length > 0) {
      throw new Error(`la migración dejó ${violations.length} filas con llaves foráneas rotas`);
    }
  } finally {
    sqlite.pragma(`foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
  }
}
