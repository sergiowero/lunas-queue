import { RunSubagentRepository } from "@lunasq/db";
import { insertProject, insertRun, insertTask, migratedDatabase } from "@lunasq/db/test-helpers";
import { REVIEWER_NAMES, RUN_TOKEN_HEADER } from "@lunasq/schemas";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { SUBAGENT_HOOK_PATH } from "./routes.ts";

function setup() {
  const db = migratedDatabase();
  const task = insertTask(db, insertProject(db).id);
  const run = insertRun(db, task.id, { phase: "verify" });
  const app = createApp({ db });
  const post = (body: unknown, token: string | null = run.runToken) =>
    app.request(SUBAGENT_HOOK_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token === null ? {} : { [RUN_TOKEN_HEADER]: token }),
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  return { db, task, run, post, recorded: () => new RunSubagentRepository(db).forRun(run.id) };
}

const hook = (event: "SubagentStart" | "SubagentStop", agentId = "a1") => ({
  session_id: "s-1",
  hook_event_name: event,
  agent_id: agentId,
  agent_type: "lunasq-security-reviewer",
  ...(event === "SubagentStop" && { agent_transcript_path: `/tmp/agent-${agentId}.jsonl` }),
});

describe("POST /hooks/subagent", () => {
  it("registra inicio y fin del subagente en el Run del token y responde {}", async () => {
    const { post, recorded } = setup();
    const res = await post(hook("SubagentStart"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    await post(hook("SubagentStop"));
    expect(recorded()).toEqual([
      expect.objectContaining({
        agentId: "a1",
        agentType: "lunasq-security-reviewer",
        startedAt: expect.any(Date),
        stoppedAt: expect.any(Date),
        transcriptPath: "/tmp/agent-a1.jsonl",
      }),
    ]);
  });

  it("repetir el hook no duplica la ejecución", async () => {
    const { post, recorded } = setup();
    await post(hook("SubagentStart"));
    await post(hook("SubagentStart"));
    expect(recorded()).toHaveLength(1);
  });

  it.each([
    ["sin token", null],
    ["con un token desconocido", "no-es-un-token"],
  ])("%s no registra nada y no bloquea al agente", async (_, token) => {
    const { post, recorded } = setup();
    const res = await post(hook("SubagentStart"), token);
    expect(res.status).toBe(200);
    expect(recorded()).toEqual([]);
  });

  it("el token de un Run cerrado ya no registra", async () => {
    const { db, task, post } = setup();
    const closed = insertRun(db, task.id, { phase: "verify", endedAt: new Date() });
    await post(hook("SubagentStart"), closed.runToken);
    expect(new RunSubagentRepository(db).forRun(closed.id)).toEqual([]);
  });

  it("un input que no es de SubagentStart o SubagentStop responde 400 sin efectos", async () => {
    const { post, recorded } = setup();
    const bad = await post({ ...hook("SubagentStart"), hook_event_name: "PreToolUse" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "invalid_hook_input" });
    expect((await post("{no es json")).status).toBe(400);
    expect(recorded()).toEqual([]);
  });

  it("sin un token activo ni siquiera valida el input: responde {} sin detalles", async () => {
    const { post } = setup();
    const res = await post("{no es json", "no-es-un-token");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it("con el session id nativo del Run fijado, ignora hooks de otra sesión con el mismo token", async () => {
    const { db, task } = setup();
    const run = insertRun(db, insertTask(db, task.projectId).id, {
      phase: "verify",
      agentSession: "s-nativa",
      agentSessionSource: "native",
    });
    const app = createApp({ db });
    const send = (sessionId: string, agentId: string) =>
      app.request(SUBAGENT_HOOK_PATH, {
        method: "POST",
        headers: { "content-type": "application/json", [RUN_TOKEN_HEADER]: run.runToken },
        body: JSON.stringify({ ...hook("SubagentStart", agentId), session_id: sessionId }),
      });
    expect((await send("otra-sesion", "a1")).status).toBe(200);
    await send("s-nativa", "a2");
    expect(new RunSubagentRepository(db).forRun(run.id).map((r) => r.agentId)).toEqual(["a2"]);
  });

  it("registra los 4 revisores de una verificación, uno por agente", async () => {
    const { post, recorded } = setup();
    for (const [i, name] of REVIEWER_NAMES.entries()) {
      await post({ ...hook("SubagentStart", `r${i}`), agent_type: name });
      await post({ ...hook("SubagentStop", `r${i}`), agent_type: name });
    }
    expect(recorded().map((r) => r.agentType)).toEqual([...REVIEWER_NAMES]);
    expect(recorded().every((r) => r.startedAt && r.stoppedAt)).toBe(true);
  });
});
