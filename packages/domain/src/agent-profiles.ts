// Agent profiles (docs/decisions/agent-profiles.md): a profile is an ordered list of models, the
// primary first and then its fallbacks. A project selects one profile per phase; the effective model
// of a phase dispatch is the first model that is enabled in Settings and not yet exhausted.
// Pure rules: whoever calls reads the profile, the enabled providers and the exhausted models.
import {
  type AgentProfile,
  type AgentProviderSettings,
  PROFILE_COLORS,
  PROFILE_ICONS,
  type Phase,
  type ProfileColor,
  type ProfileIcon,
  type ProfileModel,
  type Project,
} from "@lunasq/schemas";
import { DEFAULT_VERIFY_MODEL } from "./project-config.ts";

/** Read port of the agent profiles; the scheduler, the claim and the dispatcher depend on it. */
export interface AgentProfileReader {
  get(profileId: string): AgentProfile | null;
  /** All the profiles, ordered by name. */
  list(): AgentProfile[];
}

/** A random member of `set` from `random` (a `Math.random`-like source in [0, 1)). */
function pick<T>(set: readonly T[], random: () => number): T {
  return set[Math.min(Math.floor(random() * set.length), set.length - 1)] as T;
}

/** The icon and the color for a profile that did not choose them; `random` is injectable for tests. */
export function randomAppearance(random: () => number = Math.random): {
  icon: ProfileIcon;
  color: ProfileColor;
} {
  const icon = pick(PROFILE_ICONS, random);
  const color = pick(PROFILE_COLORS, random);
  return { icon, color };
}

function copyProfile(profile: AgentProfile): AgentProfile {
  return {
    ...profile,
    models: profile.models.map((m) => ({ ...m, args: [...m.args] })),
    createdAt: new Date(profile.createdAt.getTime()),
    updatedAt: new Date(profile.updatedAt.getTime()),
  };
}

/** In-memory reader for tests of the modules that consume profiles; returns copies. */
export class InMemoryAgentProfileReader implements AgentProfileReader {
  readonly #profiles = new Map<string, AgentProfile>();

  constructor(profiles: AgentProfile[] = []) {
    for (const profile of profiles) this.#profiles.set(profile.id, copyProfile(profile));
  }

  get(profileId: string): AgentProfile | null {
    const profile = this.#profiles.get(profileId);
    return profile ? copyProfile(profile) : null;
  }

  list(): AgentProfile[] {
    return [...this.#profiles.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(copyProfile);
  }
}

/** The profile the project selected for the phase; null if the phase is unassigned. */
export function phaseProfileId(
  config: Pick<Project, "agentProfiles">,
  phase: Phase,
): string | null {
  return config.agentProfiles[phase];
}

/** Whether a model may be started: its provider is enabled in Settings. */
export function isModelEnabled(model: ProfileModel, enabled: AgentProviderSettings): boolean {
  return enabled[model.kind];
}

/** The verification approver runs on Sonnet when its effective model is Claude without a model. */
function withPhaseDefaults(phase: Phase, model: ProfileModel): ProfileModel {
  if (phase === "verify" && model.kind === "claude" && model.model === undefined) {
    return { ...model, model: DEFAULT_VERIFY_MODEL };
  }
  return model;
}

export type PhaseModel = { profileId: string; index: number; model: ProfileModel };

export type PhaseModelResolution =
  | { status: "unassigned" }
  | { status: "providers_disabled" }
  | { status: "exhausted" }
  | ({ status: "ready" } & PhaseModel);

/**
 * The effective model of a phase: the first one of the profile whose provider is enabled and that is
 * not in `exhausted` (indexes already tried in this phase dispatch).
 * - `unassigned`: the phase has no profile (or it no longer exists);
 * - `providers_disabled`: every model of the profile belongs to a disabled provider;
 * - `exhausted`: some are enabled but all of them already failed in this dispatch.
 */
export function resolvePhaseModel(
  phase: Phase,
  profile: AgentProfile | null | undefined,
  enabled: AgentProviderSettings,
  exhausted: Iterable<number> = [],
): PhaseModelResolution {
  if (!profile) return { status: "unassigned" };
  const spent = new Set(exhausted);
  let anyEnabled = false;
  for (const [index, model] of profile.models.entries()) {
    if (!isModelEnabled(model, enabled)) continue;
    anyEnabled = true;
    if (spent.has(index)) continue;
    return {
      status: "ready",
      profileId: profile.id,
      index,
      model: withPhaseDefaults(phase, model),
    };
  }
  return { status: anyEnabled ? "exhausted" : "providers_disabled" };
}

/** Resolution for a project's phase through the profile reader. */
export function resolveProjectPhase(
  config: Pick<Project, "agentProfiles">,
  phase: Phase,
  profiles: Pick<AgentProfileReader, "get">,
  enabled: AgentProviderSettings,
  exhausted: Iterable<number> = [],
): PhaseModelResolution {
  const id = phaseProfileId(config, phase);
  return resolvePhaseModel(phase, id ? profiles.get(id) : null, enabled, exhausted);
}
