import { describe, expect, it } from "vitest";
import { transcriptToMarkdown } from "./transcript.ts";

const line = (value: unknown) => JSON.stringify(value);

const session = [
  line({
    type: "user",
    timestamp: "2026-10-29T10:00:00.000Z",
    message: { role: "user", content: "Implementa T-1" },
  }),
  line({
    type: "assistant",
    timestamp: "2026-10-29T10:00:05.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "razonamiento interno largo" },
        { type: "text", text: "Voy a correr los tests." },
        { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "pnpm test" } },
      ],
    },
  }),
  line({
    type: "user",
    timestamp: "2026-10-29T10:00:30.000Z",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "12 passed\n" }],
    },
  }),
  line({ type: "summary", summary: "ruido" }),
  line({ type: "file-history-snapshot", snapshot: {} }),
].join("\n");

describe("transcriptToMarkdown", () => {
  it("convierte turnos, llamadas a tools y resultados", () => {
    const md = transcriptToMarkdown(session);
    expect(md).toContain("**Usuario** · 10:00:00");
    expect(md).toContain("Implementa T-1");
    expect(md).toContain("**Agente** · 10:00:05");
    expect(md).toContain("Voy a correr los tests.");
    expect(md).toContain("`Bash`");
    expect(md).toContain("pnpm test");
    expect(md).toContain("12 passed");
  });

  it("omite el razonamiento interno y las líneas que no son conversación", () => {
    const md = transcriptToMarkdown(session);
    expect(md).not.toContain("razonamiento interno");
    expect(md).not.toContain("ruido");
    expect(md).not.toContain("snapshot");
  });

  it("omite los mensajes de metadatos del propio Claude Code", () => {
    const md = transcriptToMarkdown(
      line({ type: "user", isMeta: true, message: { role: "user", content: "<system-reminder>" } }),
    );
    expect(md).toBe("");
  });

  it("acepta el resultado de una tool como lista de bloques de texto", () => {
    const md = transcriptToMarkdown(
      line({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t",
              content: [
                { type: "text", text: "uno" },
                { type: "text", text: "dos" },
              ],
            },
          ],
        },
      }),
    );
    expect(md).toContain("uno\ndos");
  });

  it("marca los resultados de tools con error", () => {
    const md = transcriptToMarkdown(
      line({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t", is_error: true, content: "boom" }],
        },
      }),
    );
    expect(md).toContain("error");
    expect(md).toContain("boom");
  });

  it("recorta resultados largos conservando el principio y el final", () => {
    const output = `${"a".repeat(2000)}MEDIO${"z".repeat(2000)}`;
    const md = transcriptToMarkdown(
      line({
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", content: output }] },
      }),
      { toolResultLimit: 100 },
    );
    expect(md).toContain("a".repeat(50));
    expect(md).toContain("z".repeat(50));
    expect(md).not.toContain("MEDIO");
    expect(md).toMatch(/\d+ caracteres omitidos/);
  });

  it("usa una cerca de código más larga que los backticks del contenido", () => {
    const md = transcriptToMarkdown(
      line({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", content: "```ts\nconst a = 1;\n```" }],
        },
      }),
    );
    expect(md).toContain("````\n```ts\nconst a = 1;\n```\n````");
  });

  it("resume el input de tools que no son Bash como JSON compacto y recortado", () => {
    const md = transcriptToMarkdown(
      line({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              name: "Edit",
              input: { file_path: "a.ts", old_string: "x".repeat(2000) },
            },
          ],
        },
      }),
    );
    expect(md).toContain("`Edit`");
    expect(md).toContain('"file_path":"a.ts"');
    expect(md.length).toBeLessThan(1000);
  });

  it("ignora líneas que no son JSON y avisa cuántas fueron", () => {
    const md = transcriptToMarkdown(`${session}\nno es json\n{cortado`);
    expect(md).toContain("Implementa T-1");
    expect(md).toContain("2 líneas ilegibles");
  });

  it("recorta el transcript entero conservando el principio y el final", () => {
    const lines = Array.from({ length: 400 }, (_, i) =>
      line({ type: "user", message: { role: "user", content: `mensaje ${i} ${"x".repeat(100)}` } }),
    ).join("\n");
    const md = transcriptToMarkdown(lines, { maxChars: 5000 });
    expect(md.length).toBeLessThan(6000);
    expect(md).toContain("mensaje 0 ");
    expect(md).toContain("mensaje 399 ");
    expect(md).not.toContain("mensaje 200 ");
    expect(md).toMatch(/caracteres omitidos del transcript/);
  });

  it("redacta antes de recortar: una llave cuyo BEGIN cae en el medio omitido no se filtra", () => {
    const key = `-----BEGIN RSA PRIVATE KEY-----\n${"MIIEowIBAAKCAQEA".repeat(40)}\n-----END RSA PRIVATE KEY-----`;
    const md = transcriptToMarkdown(
      line({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", content: `${"p".repeat(3000)}\n${key}` }],
        },
      }),
    );
    expect(md).not.toContain("MIIEow");
    expect(md).not.toContain("END RSA");
  });

  it("devuelve vacío para un transcript vacío", () => {
    expect(transcriptToMarkdown("")).toBe("");
  });
});
