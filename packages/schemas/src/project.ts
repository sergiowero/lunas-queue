// Configuración de un Project (docs/design.md §Modelo de dominio, §Concurrencia, §Timeout de fase).
// Forma y defaults en docs/decisions/0007-config-proyecto.md.
import { z } from "zod";
import { AgentKind, Phase } from "./enums.ts";

const nonEmpty = z.string().trim().min(1);

const profileFields = {
  model: nonEmpty.optional(),
  args: z.array(z.string()).default(() => []),
};

export const AgentProfile = z.strictObject({ kind: AgentKind, ...profileFields });
export type AgentProfile = z.infer<typeof AgentProfile>;

// La verificación depende de los subagentes de Claude Code (§Verificación con subagentes):
// su perfil se ata a "claude" y no a AgentKind, para que siga así cuando v2 sume otros kinds.
export const VerifyAgentProfile = z.strictObject({ kind: z.literal("claude"), ...profileFields });

const defaultProfile = (): AgentProfile => ({ kind: "claude", args: [] });

export const AgentProfiles = z.strictObject({
  refine: AgentProfile.default(defaultProfile),
  implement: AgentProfile.default(defaultProfile),
  verify: VerifyAgentProfile.default(defaultProfile),
  deliver: AgentProfile.default(defaultProfile),
} satisfies Record<Phase, z.ZodType>);
export type AgentProfiles = z.infer<typeof AgentProfiles>;

const positiveInt = z.int().min(1);

// setTimeout trata más de 2^31-1 ms como 1 ms; una semana queda muy por debajo.
export const MAX_PHASE_TIMEOUT_MINUTES = 7 * 24 * 60;

export const ProjectLimits = z.strictObject({
  // Tareas en in progress del proyecto; sin valor, solo aplica el límite global.
  concurrency: positiveInt.optional(),
  // Sin valor para una fase, aplica el default de 30 minutos.
  phaseTimeoutMinutes: z
    .partialRecord(Phase, positiveInt.max(MAX_PHASE_TIMEOUT_MINUTES))
    .optional(),
});
export type ProjectLimits = z.infer<typeof ProjectLimits>;

/** Normaliza una ruta POSIX absoluta sin node:path: quita `//`, `.`, `..` y la `/` final. */
function normalizePosixPath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

const configFields = {
  name: nonEmpty,
  // owner/name en GitHub, como lo recibe `gh --repo`.
  repo: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*\/(?!\.{1,2}$)[A-Za-z0-9._-]+$/, "repo debe ser owner/name"),
  baseBranch: nonEmpty,
  // Normalizada para que la unicidad de local_path no se salte con `/a/` o `/./a`.
  localPath: z
    .string()
    .startsWith("/", "localPath debe ser una ruta absoluta")
    .transform(normalizePosixPath)
    .refine((path) => path !== "/", "localPath no puede ser la raíz"),
  agentProfiles: AgentProfiles.prefault({}),
  limits: ProjectLimits.default(() => ({})),
};

export const ProjectCreate = z.strictObject({
  ...configFields,
  testCommand: nonEmpty.optional(),
  bootstrap: nonEmpty.optional(),
});
export type ProjectCreate = z.input<typeof ProjectCreate>;

// PATCH: cada campo presente reemplaza al guardado, salvo agentProfiles, que se mezcla por fase;
// null borra los opcionales.
export const ProjectUpdate = z.strictObject({
  name: configFields.name.optional(),
  repo: configFields.repo.optional(),
  baseBranch: configFields.baseBranch.optional(),
  localPath: configFields.localPath.optional(),
  agentProfiles: z
    .strictObject({
      refine: AgentProfile.optional(),
      implement: AgentProfile.optional(),
      verify: VerifyAgentProfile.optional(),
      deliver: AgentProfile.optional(),
    } satisfies Record<Phase, z.ZodType>)
    .optional(),
  limits: ProjectLimits.optional(),
  testCommand: nonEmpty.nullable().optional(),
  bootstrap: nonEmpty.nullable().optional(),
});
export type ProjectUpdate = z.input<typeof ProjectUpdate>;

export const Project = z.strictObject({
  id: z.uuid(),
  ...configFields,
  agentProfiles: AgentProfiles,
  limits: ProjectLimits,
  testCommand: nonEmpty.nullable(),
  bootstrap: nonEmpty.nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Project = z.infer<typeof Project>;
