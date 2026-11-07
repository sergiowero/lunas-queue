import { describe, expect, it } from "vitest";
import { evidenceHeader, upsertRunSection } from "./file.ts";
import { runMarkers } from "./render.ts";

const section = (id: string, body = "contenido") => {
  const { start, end } = runMarkers(id);
  return `${start}\n## Run ${id}\n${body}\n${end}\n`;
};

const header = evidenceHeader({ taskId: "task-1", goal: "Hacer algo" });

describe("evidenceHeader", () => {
  it("carries the task and its goal", () => {
    expect(header).toContain("# Evidence for task task-1");
    expect(header).toContain("Hacer algo");
  });

  it("neutralizes LunasQ markers that come in the goal", () => {
    const { end } = runMarkers("x");
    expect(evidenceHeader({ taskId: "t", goal: `hola ${end}` })).not.toContain(end);
  });
});

describe("upsertRunSection", () => {
  it("creates the file with the header and the first section", () => {
    const out = upsertRunSection(null, header, "run-1", section("run-1"));
    expect(out.startsWith(header)).toBe(true);
    expect(out).toContain(section("run-1"));
  });

  it("appends the sections of new Runs at the end, in close order", () => {
    let file = upsertRunSection(null, header, "run-1", section("run-1"));
    file = upsertRunSection(file, header, "run-2", section("run-2"));
    expect(file.indexOf("## Run run-1")).toBeLessThan(file.indexOf("## Run run-2"));
  });

  it("replaces the section of an already written Run without touching the others", () => {
    let file = upsertRunSection(null, header, "run-1", section("run-1", "viejo"));
    file = upsertRunSection(file, header, "run-2", section("run-2"));
    file = upsertRunSection(file, header, "run-1", section("run-1", "nuevo"));
    expect(file).toContain("nuevo");
    expect(file).not.toContain("viejo");
    expect(file.match(/## Run run-1/g)).toHaveLength(1);
    expect(file.indexOf("## Run run-1")).toBeLessThan(file.indexOf("## Run run-2"));
  });

  it("repeating the same section leaves the file identical", () => {
    const once = upsertRunSection(null, header, "run-1", section("run-1"));
    expect(upsertRunSection(once, header, "run-1", section("run-1"))).toBe(once);
  });

  it("rewrites the header and drops loose text someone added outside the sections", () => {
    const edited = `${header}\ntexto a mano\n${section("run-1")}`;
    const out = upsertRunSection(edited, header, "run-2", section("run-2"));
    expect(out).not.toContain("texto a mano");
    expect(out).toContain(section("run-1"));
    expect(out).toContain(section("run-2"));
  });

  it("a Run id with regex characters does not confuse another", () => {
    let file = upsertRunSection(null, header, "a.b", section("a.b", "uno"));
    file = upsertRunSection(file, header, "axb", section("axb", "dos"));
    file = upsertRunSection(file, header, "a.b", section("a.b", "tres"));
    expect(file).toContain("dos");
    expect(file).toContain("tres");
    expect(file).not.toContain("uno");
  });
});

describe("evidenceHeader marker escaping", () => {
  it("escapes a Run marker planted in the goal with the English marker", () => {
    const out = evidenceHeader({ taskId: "t", goal: "x <!-- lunasq:run:start r --> y" });
    expect(out).toContain("<!-- lunasq-escaped:run:start r -->");
    expect(out).not.toContain("<!-- lunasq:run");
  });
});
