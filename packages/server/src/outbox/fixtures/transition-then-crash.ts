// Process that confirms a transition and dies with SIGKILL before publishing anything: it simulates a
// crash between the commit and the publication (UW-08 criterion).
import { openDatabase, transitionTask } from "@lunasq/db";

const [file, taskId] = process.argv.slice(2);
if (!file || !taskId) throw new Error("uso: transition-then-crash <db> <taskId>");
const db = openDatabase(file);
const result = transitionTask(db, { taskId, actor: "system", command: { type: "dispatch" } });
if (!result.ok) throw new Error(result.error.code);
process.kill(process.pid, "SIGKILL");
