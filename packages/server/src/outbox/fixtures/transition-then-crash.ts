// Proceso que confirma una transición y muere con SIGKILL antes de publicar nada: simula una
// caída entre el commit y la publicación (criterio de UW-08).
import { openDatabase, transitionTask } from "@lunasq/db";

const [file, taskId] = process.argv.slice(2);
if (!file || !taskId) throw new Error("uso: transition-then-crash <db> <taskId>");
const db = openDatabase(file);
const result = transitionTask(db, { taskId, actor: "system", command: { type: "dispatch" } });
if (!result.ok) throw new Error(result.error.code);
process.kill(process.pid, "SIGKILL");
