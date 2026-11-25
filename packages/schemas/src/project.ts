// Configuration of a Project (docs/design.md §Domain model, §Concurrency, §Phase timeout).
// Shape and defaults in docs/decisions/0008-config-proyecto.md.
import { z } from "zod";
import { AgentKind, Phase } from "./enums.ts";
import { MAX_VERIFICATION_ITERATIONS } from "./settings.ts";

const nonEmpty = z.string().trim().min(1);

// Effort levels shared by Claude Code, Copilot CLI and Codex CLI.
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export const EffortLevel = z.enum(EFFORT_LEVELS);
export type EffortLevel = z.infer<typeof EffortLevel>;

const hasEffortFlag = (args: readonly string[]) =>
  args.some((arg) => arg === "--effort" || arg.startsWith("--effort="));

// One entry of an agent profile (docs/decisions/agent-profiles.md): which provider and model run the
// phase, with which effort and extra args. The first entry of a profile is the primary and the rest
// are its fallbacks. The flags each provider reserves are checked by the adapters.
export const ProfileModel = z
  .strictObject({
    kind: AgentKind,
    model: nonEmpty.optional(),
    effort: EffortLevel.optional(),
    args: z.array(z.string()).default(() => []),
  })
  .refine((m) => m.effort === undefined || !hasEffortFlag(m.args), {
    message: "the model sets effort and also carries --effort in args: keep one",
    path: ["args"],
  });
export type ProfileModel = z.infer<typeof ProfileModel>;

export const MIN_PROFILE_MODELS = 1;
export const MAX_PROFILE_MODELS = 10;

const profileName = nonEmpty.max(100);
const profileModels = z.array(ProfileModel).min(MIN_PROFILE_MODELS).max(MAX_PROFILE_MODELS);

// Appearance of an agent profile in the UI: one icon and one color of closed sets. The web renders
// the icon as an inline SVG and the color through a theme token, so both names are stable keys.
export const PROFILE_ICONS = [
  "bot",
  "sparkles",
  "bolt",
  "brain",
  "rocket",
  "wrench",
  "shield",
  "flask",
  "compass",
  "leaf",
] as const;
export const ProfileIcon = z.enum(PROFILE_ICONS);
export type ProfileIcon = z.infer<typeof ProfileIcon>;

export const PROFILE_COLORS = [
  "red",
  "orange",
  "amber",
  "green",
  "teal",
  "blue",
  "violet",
  "pink",
] as const;
export const ProfileColor = z.enum(PROFILE_COLORS);
export type ProfileColor = z.infer<typeof ProfileColor>;

/** Named, global list of models: the primary first and then its fallbacks in order. */
export const AgentProfile = z.strictObject({
  id: z.uuid(),
  name: profileName,
  models: profileModels,
  icon: ProfileIcon,
  color: ProfileColor,
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type AgentProfile = z.infer<typeof AgentProfile>;

// Without icon or color, the repository assigns a random one of each set.
export const AgentProfileCreate = z.strictObject({
  name: profileName,
  models: profileModels,
  icon: ProfileIcon.optional(),
  color: ProfileColor.optional(),
});
export type AgentProfileCreate = z.input<typeof AgentProfileCreate>;

// PATCH: each present field replaces the stored one.
export const AgentProfileUpdate = z.strictObject({
  name: profileName.optional(),
  models: profileModels.optional(),
  icon: ProfileIcon.optional(),
  color: ProfileColor.optional(),
});
export type AgentProfileUpdate = z.input<typeof AgentProfileUpdate>;

/** The agent profile a project selects for each phase; null leaves the phase unassigned. */
export const PhaseProfiles = z.strictObject({
  refine: z.uuid().nullable().default(null),
  implement: z.uuid().nullable().default(null),
  verify: z.uuid().nullable().default(null),
  deliver: z.uuid().nullable().default(null),
} satisfies Record<Phase, z.ZodType>);
export type PhaseProfiles = z.infer<typeof PhaseProfiles>;

/** Phases of a project without an agent profile: its tasks wait in queued until one is assigned. */
export function unassignedPhases(profiles: PhaseProfiles): Phase[] {
  return Phase.options.filter((phase) => profiles[phase] === null);
}

const positiveInt = z.int().min(1);

// setTimeout treats more than 2^31-1 ms as 1 ms; a week is well below that.
export const MAX_PHASE_TIMEOUT_MINUTES = 7 * 24 * 60;

export const ProjectLimits = z.strictObject({
  // Live agents of the project across all phases (ADR 0014); without a value, only the global one applies.
  concurrency: positiveInt.optional(),
  // Without a value for a phase, the default of 30 minutes applies.
  phaseTimeoutMinutes: z
    .partialRecord(Phase, positiveInt.max(MAX_PHASE_TIMEOUT_MINUTES))
    .optional(),
  // Reworks of the verification loop before needs_human; without a value, the global cap from Settings applies (default 5).
  maxVerificationIterations: positiveInt.max(MAX_VERIFICATION_ITERATIONS).optional(),
});
export type ProjectLimits = z.infer<typeof ProjectLimits>;

/** Normalizes an absolute POSIX path without node:path: removes `//`, `.`, `..` and the trailing `/`. */
function normalizePosixPath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

// Optional visual identity of a project (docs/decisions/0008-config-proyecto.md): a closed set of
// built-in icons and a closed palette. The UI maps each key to an SVG and to a theme token.
export const PROJECT_ICONS = [
  "folder",
  "code",
  "terminal",
  "globe",
  "database",
  "server",
  "rocket",
  "book",
  "package",
  "mobile",
  "cloud",
  "bolt",
  "pokeball",
] as const;
export const ProjectIcon = z.enum(PROJECT_ICONS);
export type ProjectIcon = z.infer<typeof ProjectIcon>;

export const PROJECT_COLORS = [
  "red",
  "orange",
  "amber",
  "green",
  "teal",
  "blue",
  "violet",
  "pink",
] as const;
export const ProjectColor = z.enum(PROJECT_COLORS);
export type ProjectColor = z.infer<typeof ProjectColor>;

const configFields = {
  name: nonEmpty,
  // owner/name on GitHub, as `gh --repo` receives it.
  repo: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*\/(?!\.{1,2}$)[A-Za-z0-9._-]+$/, "repo must be owner/name"),
  baseBranch: nonEmpty,
  // Normalized so that the uniqueness of local_path is not bypassed with `/a/` or `/./a`.
  localPath: z
    .string()
    .startsWith("/", "localPath must be an absolute path")
    .transform(normalizePosixPath)
    .refine((path) => path !== "/", "localPath cannot be the root"),
  agentProfiles: PhaseProfiles.prefault({}),
  limits: ProjectLimits.default(() => ({})),
};

export const ProjectCreate = z.strictObject({
  ...configFields,
  testCommand: nonEmpty.optional(),
  bootstrap: nonEmpty.optional(),
  icon: ProjectIcon.optional(),
  color: ProjectColor.optional(),
});
export type ProjectCreate = z.input<typeof ProjectCreate>;

// PATCH: each present field replaces the stored one, except agentProfiles, which is merged per phase;
// null deletes the optional ones.
export const ProjectUpdate = z.strictObject({
  name: configFields.name.optional(),
  repo: configFields.repo.optional(),
  baseBranch: configFields.baseBranch.optional(),
  localPath: configFields.localPath.optional(),
  agentProfiles: z
    .strictObject({
      refine: z.uuid().nullable().optional(),
      implement: z.uuid().nullable().optional(),
      verify: z.uuid().nullable().optional(),
      deliver: z.uuid().nullable().optional(),
    } satisfies Record<Phase, z.ZodType>)
    .optional(),
  limits: ProjectLimits.optional(),
  testCommand: nonEmpty.nullable().optional(),
  bootstrap: nonEmpty.nullable().optional(),
  icon: ProjectIcon.nullable().optional(),
  color: ProjectColor.nullable().optional(),
});
export type ProjectUpdate = z.input<typeof ProjectUpdate>;

export const Project = z.strictObject({
  id: z.uuid(),
  ...configFields,
  agentProfiles: PhaseProfiles,
  limits: ProjectLimits,
  testCommand: nonEmpty.nullable(),
  bootstrap: nonEmpty.nullable(),
  icon: ProjectIcon.nullable(),
  color: ProjectColor.nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Project = z.infer<typeof Project>;

// Global events (taskId null): they wake the scheduler so it replans with the new configuration.
export const AGENT_PROFILE_CREATED = "agent_profile.created";
export const AGENT_PROFILE_UPDATED = "agent_profile.updated";
export const AGENT_PROFILE_DELETED = "agent_profile.deleted";
export const PROJECT_UPDATED = "project.updated";

export const AgentProfileEventPayload = z.strictObject({
  profileId: z.uuid(),
  name: nonEmpty,
});
export type AgentProfileEventPayload = z.infer<typeof AgentProfileEventPayload>;

/** A project's configuration was saved; carries the phase profiles so held tasks are reconsidered. */
export const ProjectUpdatedPayload = z.strictObject({
  projectId: z.uuid(),
  agentProfiles: PhaseProfiles,
});
export type ProjectUpdatedPayload = z.infer<typeof ProjectUpdatedPayload>;
