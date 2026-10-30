// Puerto de lectura de la configuración de un Project (docs/decisions/0008-config-proyecto.md).
// Dispatcher, gate de tests y hooks dependen de esta interfaz, no de la base.
import { type AgentProfile, type Phase, Project } from "@lunasq/schemas";
import { DEFAULT_MAX_ITERATIONS } from "./state-machine.ts";

export interface ProjectConfigReader {
  get(projectId: string): Project | null;
  /** Todos los proyectos, ordenados por nombre. */
  list(): Project[];
}

export const DEFAULT_PHASE_TIMEOUT_MINUTES = 30;

/** El approver de verificación corre en Sonnet salvo que el perfil fije otro modelo. */
export const DEFAULT_VERIFY_MODEL = "sonnet";

export function phaseProfile(config: Project, phase: Phase): AgentProfile {
  const profile = config.agentProfiles[phase];
  if (phase === "verify" && profile.model === undefined) {
    return { ...profile, model: DEFAULT_VERIFY_MODEL };
  }
  return profile;
}

/** Reworks que admite el loop de verificación antes de pasar a needs_human. */
export function maxVerificationIterations(config: Project): number {
  return config.limits.maxVerificationIterations ?? DEFAULT_MAX_ITERATIONS;
}

export function phaseTimeoutMs(config: Project, phase: Phase): number {
  const minutes = config.limits.phaseTimeoutMinutes?.[phase] ?? DEFAULT_PHASE_TIMEOUT_MINUTES;
  return minutes * 60_000;
}

/** Copia profunda validada; Project.parse no copia las fechas. */
function copy(config: Project): Project {
  const parsed = Project.parse(config);
  return {
    ...parsed,
    createdAt: new Date(parsed.createdAt.getTime()),
    updatedAt: new Date(parsed.updatedAt.getTime()),
  };
}

/** Reader en memoria para tests de los módulos que consumen la configuración; devuelve copias. */
export class InMemoryProjectConfigReader implements ProjectConfigReader {
  readonly #configs = new Map<string, Project>();

  constructor(configs: Project[] = []) {
    for (const config of configs) this.#configs.set(config.id, copy(config));
  }

  get(projectId: string): Project | null {
    const config = this.#configs.get(projectId);
    return config ? copy(config) : null;
  }

  list(): Project[] {
    return [...this.#configs.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((config) => copy(config));
  }
}
