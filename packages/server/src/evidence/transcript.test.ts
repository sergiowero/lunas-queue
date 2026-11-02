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
  it("converts turns, tool calls and results", () => {
    const md = transcriptToMarkdown(session);
    expect(md).toContain("**User** · 10:00:00");
    expect(md).toContain("Implementa T-1");
    expect(md).toContain("**Agent** · 10:00:05");
    expect(md).toContain("Voy a correr los tests.");
    expect(md).toContain("`Bash`");
    expect(md).toContain("pnpm test");
    expect(md).toContain("12 passed");
  });

  it("omits the internal reasoning and the lines that are not conversation", () => {
    const md = transcriptToMarkdown(session);
    expect(md).not.toContain("razonamiento interno");
    expect(md).not.toContain("ruido");
    expect(md).not.toContain("snapshot");
  });

  it("omits Claude Code's own metadata messages", () => {
    const md = transcriptToMarkdown(
      line({ type: "user", isMeta: true, message: { role: "user", content: "<system-reminder>" } }),
    );
    expect(md).toBe("");
  });

  it("accepts a tool result as a list of text blocks", () => {
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

  it("marks tool results with errors", () => {
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

  it("trims long results keeping the beginning and the end", () => {
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
    expect(md).toMatch(/\d+ characters omitted/);
  });

  it("uses a code fence longer than the content's backticks", () => {
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

  it("summarizes the input of non-Bash tools as compact, trimmed JSON", () => {
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

  it("ignores lines that are not JSON and reports how many there were", () => {
    const md = transcriptToMarkdown(`${session}\nno es json\n{cortado`);
    expect(md).toContain("Implementa T-1");
    expect(md).toContain("2 unreadable lines");
  });

  it("trims the whole transcript keeping the beginning and the end", () => {
    const lines = Array.from({ length: 400 }, (_, i) =>
      line({ type: "user", message: { role: "user", content: `mensaje ${i} ${"x".repeat(100)}` } }),
    ).join("\n");
    const md = transcriptToMarkdown(lines, { maxChars: 5000 });
    expect(md.length).toBeLessThan(6000);
    expect(md).toContain("mensaje 0 ");
    expect(md).toContain("mensaje 399 ");
    expect(md).not.toContain("mensaje 200 ");
    expect(md).toMatch(/characters omitted from the transcript/);
  });

  it("redacts before trimming: a key whose BEGIN falls in the omitted middle does not leak", () => {
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

  it("returns empty for an empty transcript", () => {
    expect(transcriptToMarkdown("")).toBe("");
  });
});
