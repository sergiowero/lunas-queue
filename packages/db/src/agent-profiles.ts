// Agent profiles repository (docs/decisions/agent-profiles.md): global, named lists of models. It
// validates with the @lunasq/schemas schemas what enters and what leaves the JSON column, publishes
// the global events that wake the scheduler and implements the domain read port.
import { type AgentProfileReader, randomAppearance } from "@lunasq/domain";
import {
  AGENT_PROFILE_CREATED,
  AGENT_PROFILE_DELETED,
  AGENT_PROFILE_UPDATED,
  AgentProfile,
  AgentProfileCreate,
  AgentProfileEventPayload,
  AgentProfileUpdate,
  type Phase,
} from "@lunasq/schemas";
import { asc, eq } from "drizzle-orm";
import type { LunasqDatabase } from "./client.ts";
import { appendEvent } from "./event-log.ts";
import { agentProfiles, projects } from "./schema.ts";

export type AgentProfileRepositoryErrorCode = "conflict" | "in_use" | "invalid_row";

/** A project that selects the profile and the phases it uses it in. */
export type ProfileUsage = { projectId: string; projectName: string; phases: Phase[] };

export class AgentProfileRepositoryError extends Error {
  readonly code: AgentProfileRepositoryErrorCode;
  /** With `in_use`: the projects that use the profile. */
  readonly usedBy: ProfileUsage[];

  constructor(
    code: AgentProfileRepositoryErrorCode,
    message: string,
    options: ErrorOptions & { usedBy?: ProfileUsage[] } = {},
  ) {
    super(message, options);
    this.name = "AgentProfileRepositoryError";
    this.code = code;
    this.usedBy = options.usedBy ?? [];
  }
}

type Row = typeof agentProfiles.$inferSelect;
type Reader = Pick<LunasqDatabase, "select">;

function toProfile(row: Row): AgentProfile {
  const result = AgentProfile.safeParse(row);
  if (!result.success) {
    throw new AgentProfileRepositoryError("invalid_row", `invalid agent profile ${row.id}`, {
      cause: result.error,
    });
  }
  return result.data;
}

function isUniqueName(error: unknown): boolean {
  for (let e = error; e instanceof Error; e = e.cause) {
    if (
      "code" in e &&
      e.code === "SQLITE_CONSTRAINT_UNIQUE" &&
      /agent_profiles\.name/.test(e.message)
    ) {
      return true;
    }
  }
  return false;
}

function translate(error: unknown, name: string | undefined): never {
  if (isUniqueName(error)) {
    throw new AgentProfileRepositoryError(
      "conflict",
      `an agent profile named ${JSON.stringify(name)} already exists`,
      { cause: error },
    );
  }
  throw error;
}

/** Projects that select `profileId` in some phase. Accepts a transaction. */
export function profileUsage(db: Reader, profileId: string): ProfileUsage[] {
  const usage: ProfileUsage[] = [];
  for (const row of db.select().from(projects).orderBy(asc(projects.name)).all()) {
    const assigned = row.agentProfiles as Partial<Record<Phase, unknown>>;
    const phases = (["refine", "implement", "verify", "deliver"] as const).filter(
      (phase) => assigned[phase] === profileId,
    );
    if (phases.length > 0) usage.push({ projectId: row.id, projectName: row.name, phases });
  }
  return usage;
}

/** Whether the profile exists. Accepts a transaction. */
export function agentProfileExists(db: Reader, profileId: string): boolean {
  return (
    db
      .select({ id: agentProfiles.id })
      .from(agentProfiles)
      .where(eq(agentProfiles.id, profileId))
      .get() !== undefined
  );
}

/** Reads one profile; null if it does not exist. Accepts a transaction. */
export function readAgentProfile(db: Reader, profileId: string): AgentProfile | null {
  const row = db.select().from(agentProfiles).where(eq(agentProfiles.id, profileId)).get();
  return row ? toProfile(row) : null;
}

export class AgentProfileRepository implements AgentProfileReader {
  private readonly db: LunasqDatabase;
  private readonly random: () => number;

  /** `random` is the source of the appearance given to profiles created without one (injectable for tests). */
  constructor(db: LunasqDatabase, random: () => number = Math.random) {
    this.db = db;
    this.random = random;
  }

  /** Validates `input` (throws ZodError if it does not meet it), stores the profile and publishes the event. */
  create(input: AgentProfileCreate): AgentProfile {
    const parsed = AgentProfileCreate.parse(input);
    // Each missing half of the appearance is drawn at random from its set.
    const random = randomAppearance(this.random);
    const values = {
      ...parsed,
      icon: parsed.icon ?? random.icon,
      color: parsed.color ?? random.color,
    };
    try {
      return this.db.transaction((tx) => {
        const [row] = tx.insert(agentProfiles).values(values).returning().all();
        if (!row) throw new Error("agent profile insert without a row");
        const profile = toProfile(row);
        this.publish(tx, AGENT_PROFILE_CREATED, profile);
        return profile;
      });
    } catch (error) {
      translate(error, values.name);
    }
  }

  get(profileId: string): AgentProfile | null {
    return readAgentProfile(this.db, profileId);
  }

  /** Ordered by name. Fails with invalid_row if any row is not valid. */
  list(): AgentProfile[] {
    return this.db
      .select()
      .from(agentProfiles)
      .orderBy(asc(agentProfiles.name))
      .all()
      .map(toProfile);
  }

  /** Projects that select the profile (empty if it is unused or does not exist). */
  usage(profileId: string): ProfileUsage[] {
    return profileUsage(this.db, profileId);
  }

  /**
   * Replaces the fields present in `patch`. A change publishes `agent_profile.updated` so the
   * scheduler replans; a PATCH that changes nothing writes and publishes nothing. Live Runs are
   * never touched: only new dispatches and launches read the change.
   */
  update(profileId: string, patch: AgentProfileUpdate): AgentProfile | null {
    const values = AgentProfileUpdate.parse(patch);
    try {
      return this.db.transaction((tx) => {
        const current = readAgentProfile(tx, profileId);
        if (!current) return null;
        const changed =
          (values.name !== undefined && values.name !== current.name) ||
          (values.models !== undefined &&
            JSON.stringify(values.models) !== JSON.stringify(current.models)) ||
          (values.icon !== undefined && values.icon !== current.icon) ||
          (values.color !== undefined && values.color !== current.color);
        if (!changed) return current;
        const [row] = tx
          .update(agentProfiles)
          .set(values)
          .where(eq(agentProfiles.id, profileId))
          .returning()
          .all();
        if (!row) throw new Error("agent profile update without a row");
        const profile = toProfile(row);
        this.publish(tx, AGENT_PROFILE_UPDATED, profile);
        return profile;
      });
    } catch (error) {
      translate(error, values.name);
    }
  }

  /**
   * Returns false if it did not exist; throws `in_use` (with the projects) if a project selects it
   * in some phase.
   */
  delete(profileId: string): boolean {
    return this.db.transaction(
      (tx) => {
        const current = readAgentProfile(tx, profileId);
        if (!current) return false;
        const usedBy = profileUsage(tx, profileId);
        if (usedBy.length > 0) {
          throw new AgentProfileRepositoryError(
            "in_use",
            `the agent profile is used by ${usedBy.map((u) => u.projectName).join(", ")}`,
            { usedBy },
          );
        }
        tx.delete(agentProfiles).where(eq(agentProfiles.id, profileId)).run();
        this.publish(tx, AGENT_PROFILE_DELETED, current);
        return true;
      },
      { behavior: "immediate" },
    );
  }

  private publish(
    tx: Pick<LunasqDatabase, "insert" | "transaction">,
    type: string,
    profile: AgentProfile,
  ) {
    appendEvent(
      tx,
      {
        taskId: null,
        type,
        actor: "human",
        payload: AgentProfileEventPayload.parse({ profileId: profile.id, name: profile.name }),
      },
      { publish: true },
    );
  }
}
