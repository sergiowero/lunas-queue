// Process that receives an outbox message and dies with SIGKILL inside the handler, before the
// publisher marks it: the next publisher must deliver it again (at-least-once).
import { openDatabase } from "@lunasq/db";
import { OutboxPublisher } from "../publisher.ts";

const [file] = process.argv.slice(2);
if (!file) throw new Error("uso: deliver-then-crash <db>");
const publisher = new OutboxPublisher({ db: openDatabase(file) });
publisher.subscribe("*", () => {
  process.kill(process.pid, "SIGKILL");
});
await publisher.drain();
throw new Error("the handler did not run");
