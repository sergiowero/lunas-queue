// Read port of a Project's configuration (docs/decisions/0008-config-proyecto.md).
// Dispatcher, test gate and hooks depend on this interface, not on the database.
import { type AgentProfile, type Phase, Project } from "@lunasq/schemas";
import { DEFAULT_MAX_ITERATIONS } from "./state-machine.ts";

export interface ProjectConfigReader {
  get(projectId: string): Project | null;
  /** All the projects, ordered by name. */
  list(): Project[];
}

export const DEFAULT_PHASE_TIMEOUT_MINUTES = 30;

/** The verification approver runs on Sonnet unless the profile sets another model. */
export const DEFAULT_VERIFY_MODEL = "sonnet";

export function phaseProfile(config: Project, phase: Phase): AgentProfile {
  const profile = config.agentProfiles[phase];
  if (phase === "verify" && profile.kind === "claude" && profile.model === undefined) {
    return { ...profile, model: DEFAULT_VERIFY_MODEL };
  }
  return profile;
}

/**
 * Reworks that the verification loop allows before moving to needs_human: the project cap if
 * defined, otherwise the global cap saved in Settings, otherwise DEFAULT_MAX_ITERATIONS.
 */
export function maxVerificationIterations(config: Project, globalCap?: number): number {
  return config.limits.maxVerificationIterations ?? globalCap ?? DEFAULT_MAX_ITERATIONS;
}

export function phaseTimeoutMs(config: Project, phase: Phase): number {
  const minutes = config.limits.phaseTimeoutMinutes?.[phase] ?? DEFAULT_PHASE_TIMEOUT_MINUTES;
  return minutes * 60_000;
}

/** Validated deep copy; Project.parse does not copy the dates. */
function copy(config: Project): Project {
  const parsed = Project.parse(config);
  return {
    ...parsed,
    createdAt: new Date(parsed.createdAt.getTime()),
    updatedAt: new Date(parsed.updatedAt.getTime()),
  };
}

/** In-memory reader for tests of the modules that consume the configuration; returns copies. */
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
