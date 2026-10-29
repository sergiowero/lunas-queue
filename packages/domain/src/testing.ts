// Suite de contrato de ProjectConfigReader: corre contra el reader en memoria y contra el
// repositorio de @lunasq/db, para que ambos se comporten igual.
import { Project, ProjectCreate } from "@lunasq/schemas";
import { describe, expect, it } from "vitest";
import type { ProjectConfigReader } from "./project-config.ts";

let seq = 0;

/** UUID v4 válido y determinístico (domain no tiene `crypto`). */
export function fakeUuid(): string {
  seq += 1;
  return `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
}

/** Proyecto completo y validado, como lo devuelve un ProjectConfigReader. */
export function sampleProject(name: string, overrides: Partial<ProjectCreate> = {}): Project {
  const now = new Date();
  return Project.parse({
    testCommand: null,
    bootstrap: null,
    ...ProjectCreate.parse({
      name,
      repo: `sergiowero/${name}`,
      baseBranch: "main",
      localPath: `/repos/${name}`,
      ...overrides,
    }),
    id: fakeUuid(),
    createdAt: now,
    updatedAt: now,
  });
}

export function projectConfigReaderContract(
  name: string,
  setup: (configs: Project[]) => ProjectConfigReader,
): void {
  describe(`contrato de ProjectConfigReader: ${name}`, () => {
    it("devuelve la configuración completa de un proyecto", () => {
      const config = sampleProject("beta", {
        agentProfiles: { verify: { kind: "claude", model: "sonnet", args: ["--x"] } },
        limits: { concurrency: 2, phaseTimeoutMinutes: { implement: 60 } },
        testCommand: "pnpm test",
        bootstrap: "pnpm install",
      });
      const reader = setup([config]);
      expect(reader.get(config.id)).toEqual(config);
    });

    it("devuelve null si el proyecto no existe", () => {
      const reader = setup([sampleProject("alfa")]);
      expect(reader.get(fakeUuid())).toBeNull();
    });

    it("lista los proyectos ordenados por nombre", () => {
      const reader = setup([sampleProject("gamma"), sampleProject("alfa"), sampleProject("beta")]);
      expect(reader.list().map((p) => p.name)).toEqual(["alfa", "beta", "gamma"]);
    });

    it("modificar lo leído no cambia la configuración", () => {
      const config = sampleProject("alfa");
      const reader = setup([config]);
      const read = reader.get(config.id);
      if (!read) throw new Error("sin proyecto");
      read.agentProfiles.refine.args.push("--mutado");
      read.createdAt.setFullYear(1990);
      expect(reader.get(config.id)?.agentProfiles.refine.args).toEqual([]);
      expect(reader.get(config.id)?.createdAt).toEqual(config.createdAt);
    });
  });
}
