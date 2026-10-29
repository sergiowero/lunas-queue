import { projectConfigReaderContract } from "@lunasq/domain/testing";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { ProjectRepository, ProjectRepositoryError } from "./projects.ts";
import { projects } from "./schema.ts";
import { insertProject, insertTask, migratedDatabase } from "./test-helpers.ts";

// Un kind que el esquema rechaza; el cast salta la verificación de tipos a propósito.
const codex = { kind: "codex" } as unknown as { kind: "claude" };

const input = {
  name: "lunas-queue",
  repo: "sergiowero/lunas-queue",
  baseBranch: "main",
  localPath: "/repos/lunas-queue",
};

function repository() {
  const db = migratedDatabase();
  return { db, repo: new ProjectRepository(db) };
}

function errorOf(fn: () => unknown): ProjectRepositoryError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ProjectRepositoryError) return error;
    throw error;
  }
  throw new Error("no lanzó");
}

describe("ProjectRepository.create", () => {
  it("guarda el proyecto con defaults y lo devuelve validado", () => {
    const { repo } = repository();
    const project = repo.create(input);
    expect(project).toMatchObject({ ...input, limits: {}, testCommand: null, bootstrap: null });
    expect(project.agentProfiles.verify).toEqual({ kind: "claude", args: [] });
    expect(repo.get(project.id)).toEqual(project);
  });

  it("valida la entrada", () => {
    const { repo } = repository();
    expect(() => repo.create({ ...input, agentProfiles: { verify: codex } })).toThrow(
      /"invalid_value"[\s\S]*"verify"/,
    );
    expect(repo.list()).toEqual([]);
  });

  it("traduce nombre o ruta repetidos a conflict con el campo", () => {
    const { repo } = repository();
    repo.create(input);
    const byName = errorOf(() => repo.create({ ...input, localPath: "/repos/otra" }));
    expect(byName).toMatchObject({ code: "conflict", field: "name" });
    const byPath = errorOf(() => repo.create({ ...input, name: "otro" }));
    expect(byPath).toMatchObject({ code: "conflict", field: "localPath" });
  });
});

describe("ProjectRepository.get y list", () => {
  it("get devuelve null para ids inexistentes", () => {
    const { repo } = repository();
    expect(repo.get(crypto.randomUUID())).toBeNull();
    expect(repo.get("no-es-uuid")).toBeNull();
  });

  it("lee filas antiguas con JSON vacío aplicando los defaults", () => {
    const { db, repo } = repository();
    const row = insertProject(db);
    expect(repo.get(row.id)?.agentProfiles.refine).toEqual({ kind: "claude", args: [] });
  });

  it("falla con invalid_row si el JSON guardado no cumple el esquema", () => {
    const { db, repo } = repository();
    const row = insertProject(db, { agentProfiles: { verify: codex } });
    expect(errorOf(() => repo.get(row.id))).toMatchObject({ code: "invalid_row" });
  });
});

describe("ProjectRepository.update", () => {
  it("reemplaza solo los campos presentes", () => {
    const { repo } = repository();
    const created = repo.create({
      ...input,
      testCommand: "pnpm test",
      agentProfiles: { implement: { kind: "claude", model: "opus" } },
    });
    const updated = repo.update(created.id, {
      baseBranch: "develop",
      limits: { concurrency: 3 },
      testCommand: null,
    });
    expect(updated).toMatchObject({
      baseBranch: "develop",
      limits: { concurrency: 3 },
      testCommand: null,
      name: input.name,
    });
    expect(updated?.agentProfiles.implement.model).toBe("opus");
  });

  it("un patch vacío devuelve el proyecto sin cambios", () => {
    const { repo } = repository();
    const created = repo.create(input);
    expect(repo.update(created.id, {})).toEqual(created);
  });

  it("devuelve null si el proyecto no existe", () => {
    const { repo } = repository();
    expect(repo.update(crypto.randomUUID(), { baseBranch: "develop" })).toBeNull();
  });

  it("rechaza un perfil de verify con otro kind sin tocar la fila", () => {
    const { repo } = repository();
    const created = repo.create(input);
    expect(() => repo.update(created.id, { agentProfiles: { verify: codex } })).toThrow(
      /"invalid_value"[\s\S]*"verify"/,
    );
    expect(repo.get(created.id)).toEqual(created);
  });

  it("traduce un nombre repetido a conflict", () => {
    const { repo } = repository();
    repo.create(input);
    const other = repo.create({ ...input, name: "otro", localPath: "/repos/otro" });
    const error = errorOf(() => repo.update(other.id, { name: input.name }));
    expect(error).toMatchObject({ code: "conflict", field: "name" });
  });
});

describe("ProjectRepository.delete", () => {
  it("borra un proyecto sin tareas", () => {
    const { repo } = repository();
    const created = repo.create(input);
    expect(repo.delete(created.id)).toBe(true);
    expect(repo.get(created.id)).toBeNull();
    expect(repo.delete(created.id)).toBe(false);
  });

  it("falla con has_tasks si el proyecto tiene tareas", () => {
    const { db, repo } = repository();
    const created = repo.create(input);
    insertTask(db, created.id);
    expect(errorOf(() => repo.delete(created.id))).toMatchObject({ code: "has_tasks" });
    expect(db.select().from(projects).where(eq(projects.id, created.id)).all()).toHaveLength(1);
  });
});

projectConfigReaderContract("repositorio SQLite", (configs) => {
  const db = migratedDatabase();
  if (configs.length > 0) db.insert(projects).values(configs).run();
  return new ProjectRepository(db);
});

describe("ProjectRepository: hallazgos del review", () => {
  it("update renueva updatedAt", () => {
    const { db, repo } = repository();
    const old = new Date("2020-01-01T00:00:00Z");
    const row = insertProject(db, { createdAt: old, updatedAt: old });
    const updated = repo.update(row.id, { baseBranch: "develop" });
    expect(updated?.updatedAt.getTime()).toBeGreaterThan(old.getTime());
    expect(updated?.createdAt).toEqual(old);
  });

  it("el PATCH de agentProfiles mezcla por fase", () => {
    const { repo } = repository();
    const created = repo.create({
      ...input,
      agentProfiles: { implement: { kind: "claude", model: "opus" } },
    });
    const updated = repo.update(created.id, {
      agentProfiles: { verify: { kind: "claude", model: "sonnet" } },
    });
    expect(updated?.agentProfiles.implement.model).toBe("opus");
    expect(updated?.agentProfiles.verify.model).toBe("sonnet");
  });

  it("revierte el update si la fila resultante no es válida", () => {
    const { db, repo } = repository();
    const row = insertProject(db, { agentProfiles: { verify: { kind: "codex" } } });
    expect(errorOf(() => repo.update(row.id, { baseBranch: "develop" }))).toMatchObject({
      code: "invalid_row",
    });
    const [stored] = db.select().from(projects).where(eq(projects.id, row.id)).all();
    expect(stored?.baseBranch).toBe(row.baseBranch);
  });

  it("un PATCH puede corregir la fase inválida de una fila", () => {
    const { db, repo } = repository();
    const row = insertProject(db, { agentProfiles: { verify: { kind: "codex" } } });
    const fixed = repo.update(row.id, { agentProfiles: { verify: { kind: "claude" } } });
    expect(fixed?.agentProfiles.verify).toEqual({ kind: "claude", args: [] });
  });

  it("list falla con invalid_row si alguna fila no es válida", () => {
    const { db, repo } = repository();
    repo.create(input);
    insertProject(db, { limits: { concurrency: 0 } });
    expect(errorOf(() => repo.list())).toMatchObject({ code: "invalid_row" });
  });

  it("la unicidad de localPath usa la ruta normalizada", () => {
    const { repo } = repository();
    repo.create(input);
    const error = errorOf(() =>
      repo.create({ ...input, name: "otro", localPath: `${input.localPath}/` }),
    );
    expect(error).toMatchObject({ code: "conflict", field: "localPath" });
  });
});
