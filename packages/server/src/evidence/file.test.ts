import { describe, expect, it } from "vitest";
import { evidenceHeader, upsertRunSection } from "./file.ts";
import { runMarkers } from "./render.ts";

const section = (id: string, body = "contenido") => {
  const { start, end } = runMarkers(id);
  return `${start}\n## Run ${id}\n${body}\n${end}\n`;
};

const header = evidenceHeader({ taskId: "task-1", intent: "Hacer algo" });

describe("evidenceHeader", () => {
  it("lleva la tarea y su intent", () => {
    expect(header).toContain("# Evidencia de la tarea task-1");
    expect(header).toContain("Hacer algo");
  });

  it("neutraliza marcadores de LunasQ que vengan en el intent", () => {
    const { end } = runMarkers("x");
    expect(evidenceHeader({ taskId: "t", intent: `hola ${end}` })).not.toContain(end);
  });
});

describe("upsertRunSection", () => {
  it("crea el archivo con el encabezado y la primera sección", () => {
    const out = upsertRunSection(null, header, "run-1", section("run-1"));
    expect(out.startsWith(header)).toBe(true);
    expect(out).toContain(section("run-1"));
  });

  it("agrega las secciones de Runs nuevos al final, en orden de cierre", () => {
    let file = upsertRunSection(null, header, "run-1", section("run-1"));
    file = upsertRunSection(file, header, "run-2", section("run-2"));
    expect(file.indexOf("## Run run-1")).toBeLessThan(file.indexOf("## Run run-2"));
  });

  it("reemplaza la sección de un Run ya escrito sin tocar las demás", () => {
    let file = upsertRunSection(null, header, "run-1", section("run-1", "viejo"));
    file = upsertRunSection(file, header, "run-2", section("run-2"));
    file = upsertRunSection(file, header, "run-1", section("run-1", "nuevo"));
    expect(file).toContain("nuevo");
    expect(file).not.toContain("viejo");
    expect(file.match(/## Run run-1/g)).toHaveLength(1);
    expect(file.indexOf("## Run run-1")).toBeLessThan(file.indexOf("## Run run-2"));
  });

  it("repetir la misma sección deja el archivo idéntico", () => {
    const once = upsertRunSection(null, header, "run-1", section("run-1"));
    expect(upsertRunSection(once, header, "run-1", section("run-1"))).toBe(once);
  });

  it("reescribe el encabezado y descarta texto suelto que alguien agregó fuera de las secciones", () => {
    const edited = `${header}\ntexto a mano\n${section("run-1")}`;
    const out = upsertRunSection(edited, header, "run-2", section("run-2"));
    expect(out).not.toContain("texto a mano");
    expect(out).toContain(section("run-1"));
    expect(out).toContain(section("run-2"));
  });

  it("un id de Run con caracteres de regex no confunde a otro", () => {
    let file = upsertRunSection(null, header, "a.b", section("a.b", "uno"));
    file = upsertRunSection(file, header, "axb", section("axb", "dos"));
    file = upsertRunSection(file, header, "a.b", section("a.b", "tres"));
    expect(file).toContain("dos");
    expect(file).toContain("tres");
    expect(file).not.toContain("uno");
  });
});
