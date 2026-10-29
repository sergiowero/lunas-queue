import type { Notification } from "@lunasq/schemas";

export function notification(patch: Partial<Notification> = {}): Notification {
  return {
    id: "question:q-1",
    kind: "question_open",
    taskId: "t-1",
    runId: "r-1",
    title: "Pregunta abierta en t-1",
    body: "El agente espera una respuesta",
    createdAt: "2026-10-29T12:00:00.000Z",
    ...patch,
  };
}

/** Lee eventos SSE (`event`/`id`/`data`) de un stream hasta juntar `count`. */
export async function readSseEvents(
  body: ReadableStream<Uint8Array>,
  count: number,
): Promise<{
  events: { event?: string; id?: string; data: string }[];
  cancel: () => Promise<void>;
}> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const events: { event?: string; id?: string; data: string }[] = [];
  let buffer = "";
  while (events.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end = buffer.indexOf("\n\n");
    while (end !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const fields: { event?: string; id?: string; data: string } = { data: "" };
      for (const line of block.split("\n")) {
        const sep = line.indexOf(": ");
        const key = sep === -1 ? line : line.slice(0, sep);
        const val = sep === -1 ? "" : line.slice(sep + 2);
        if (key === "event") fields.event = val;
        else if (key === "id") fields.id = val;
        else if (key === "data") fields.data += val;
      }
      if (fields.event || fields.data) events.push(fields);
      end = buffer.indexOf("\n\n");
    }
  }
  return { events, cancel: () => reader.cancel() };
}
