// Puerto de lectura de la configuración de un Project (docs/decisions/0007-config-proyecto.md).
// Dispatcher, gate de tests y hooks dependen de esta interfaz, no de la base.
import { type AgentProfile, type Phase, Project } from "@lunasq/schemas";

export interface ProjectConfigReader {
  get(projectId: string): Project | null;
  /** Todos los proyectos, ordenados por nombre. */
  list(): Project[];
}

export const DEFAULT_PHASE_TIMEOUT_MINUTES = 30;

export function phaseProfile(config: Project, phase: Phase): AgentProfile {
  return config.agentProfiles[phase];
}

export function phaseTimeoutMs(config: Project, phase: Phase): number {
  const minutes = config.limits.phaseTimeoutMinutes?.[phase] ?? DEFAULT_PHASE_TIMEOUT_MINUTES;
  return minutes * 60_000;
}

/** Reader en memoria para tests de los módulos que consumen la configuración; devuelve copias. */
export class InMemoryProjectConfigReader implements ProjectConfigReader {
  readonly #configs = new Map<string, Project>();

  constructor(configs: Project[] = []) {
    for (const config of configs) this.#configs.set(config.id, Project.parse(config));
  }

  get(projectId: string): Project | null {
    const config = this.#configs.get(projectId);
    return config ? Project.parse(config) : null;
  }

  list(): Project[] {
    return [...this.#configs.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((config) => Project.parse(config));
  }
}
