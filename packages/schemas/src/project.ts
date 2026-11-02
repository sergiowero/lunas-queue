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

const profileFields = {
  model: nonEmpty.optional(),
  effort: EffortLevel.optional(),
  args: z.array(z.string()).default(() => []),
};

export const AgentProfile = z.strictObject({ kind: AgentKind, ...profileFields });
export type AgentProfile = z.infer<typeof AgentProfile>;

// Verification depends on the Claude Code subagents (§Verification with subagents):
// its profile is tied to "claude" and not to AgentKind, so that it stays that way when v2 adds other kinds.
export const VerifyAgentProfile = AgentProfile;

const defaultProfile = (): AgentProfile => ({ kind: "claude", args: [] });

export const AgentProfiles = z.strictObject({
  refine: AgentProfile.default(defaultProfile),
  implement: AgentProfile.default(defaultProfile),
  verify: VerifyAgentProfile.default(defaultProfile),
  deliver: AgentProfile.default(defaultProfile),
} satisfies Record<Phase, z.ZodType>);
export type AgentProfiles = z.infer<typeof AgentProfiles>;

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
  agentProfiles: AgentProfiles.prefault({}),
  limits: ProjectLimits.default(() => ({})),
};

export const ProjectCreate = z.strictObject({
  ...configFields,
  testCommand: nonEmpty.optional(),
  bootstrap: nonEmpty.optional(),
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
