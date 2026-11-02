// Spike: better-sqlite3 on Node 26 — WAL, synchronous transaction and Drizzle.
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

console.log(`node ${process.versions.node} (ABI ${process.versions.modules})`);
const file = join(mkdtempSync(join(tmpdir(), "lunasq-sqlite-")), "spike.db");
const sqlite = new Database(file);

const mode = sqlite.pragma("journal_mode = WAL", { simple: true });
assert.equal(mode, "wal");
console.log(`journal_mode=${mode}, sqlite ${sqlite.prepare("select sqlite_version() v").get().v}`);

sqlite.exec("create table task (id integer primary key, state text not null)");
sqlite.prepare("insert into task (id, state) values (1, 'queued')").run();

// Atomic claim: UPDATE … WHERE state = 'queued' inside a synchronous transaction.
const claim = sqlite.transaction((id: number) => {
  const r = sqlite.prepare("update task set state = 'running' where id = ? and state = 'queued'").run(id);
  return r.changes === 1;
});
assert.equal(claim(1), true);
assert.equal(claim(1), false);
console.log("atomic claim: first wins, second fails");

// Rollback ante throw.
const failing = sqlite.transaction(() => {
  sqlite.prepare("update task set state = 'done' where id = 1").run();
  throw new Error("boom");
});
assert.throws(() => failing());
assert.equal(sqlite.prepare("select state from task where id = 1").get().state, "running");
console.log("rollback on exception: ok");

// Drizzle over the same connection.
const task = sqliteTable("task", { id: integer().primaryKey(), state: text().notNull() });
const db = drizzle({ client: sqlite });
db.transaction((tx) => {
  tx.insert(task).values({ id: 2, state: "queued" }).run();
  const res = tx.update(task).set({ state: "running" }).where(sql`${task.id} = 2 and ${task.state} = 'queued'`).run();
  assert.equal(res.changes, 1);
});
assert.deepEqual(db.select().from(task).where(eq(task.id, 2)).all(), [{ id: 2, state: "running" }]);
console.log("drizzle-orm/better-sqlite3: transaction and query ok");
sqlite.close();
