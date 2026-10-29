// Proceso que recibe un mensaje del outbox y muere con SIGKILL dentro del handler, antes de que
// el publicador lo marque: el siguiente publicador debe entregarlo otra vez (at-least-once).
import { openDatabase } from "@lunasq/db";
import { OutboxPublisher } from "../publisher.ts";

const [file] = process.argv.slice(2);
if (!file) throw new Error("uso: deliver-then-crash <db>");
const publisher = new OutboxPublisher({ db: openDatabase(file) });
publisher.subscribe("*", () => {
  process.kill(process.pid, "SIGKILL");
});
await publisher.drain();
throw new Error("el handler no se ejecutó");
