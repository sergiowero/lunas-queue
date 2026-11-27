// Agent profile routes (docs/decisions/agent-profiles.md). Validation lives in the @lunasq/schemas
// schemas and, for the flags each provider reserves, in the adapters; here their errors and the
// repository's are translated into HTTP codes. Like /api/settings, they only accept local origins:
// a profile decides which agent processes LunasQ starts.
import { AgentProviderError, validateProfileModel } from "@lunasq/adapters";
import { type AgentProfileRepository, AgentProfileRepositoryError } from "@lunasq/db";
import { AgentProfileCreate, AgentProfileUpdate, type ProfileModel } from "@lunasq/schemas";
import { type Context, Hono } from "hono";
import { invalidInput, invalidJson, localOriginOnly, notFound, readJson } from "./http.ts";

type Issue = { path: PropertyKey[]; message: string };

/** The reserved flags of each model's provider; the message names the conflicting flag. */
function flagIssues(models: readonly ProfileModel[] | undefined): Issue[] {
  const issues: Issue[] = [];
  for (const [index, model] of (models ?? []).entries()) {
    try {
      validateProfileModel(model);
    } catch (error) {
      if (!(error instanceof AgentProviderError)) throw error;
      issues.push({ path: ["models", index, "args"], message: error.message });
    }
  }
  return issues;
}

function repositoryError(c: Context, error: unknown) {
  if (error instanceof AgentProfileRepositoryError) {
    if (error.code === "conflict") {
      return invalidInput(c, { issues: [{ path: ["name"], message: error.message }] });
    }
    if (error.code === "in_use") {
      return c.json(
        {
          error: "profile_in_use",
          message: error.message,
          projects: error.usedBy.map((u) => ({
            id: u.projectId,
            name: u.projectName,
            phases: u.phases,
          })),
        },
        409,
      );
    }
  }
  throw error;
}

export function agentProfileRoutes(profiles: AgentProfileRepository): Hono {
  return new Hono()
    .use(localOriginOnly)
    .get("/", (c) => c.json(profiles.list()))
    .post("/", async (c) => {
      const json = await readJson(c);
      if (!json.ok) return invalidJson(c);
      const input = AgentProfileCreate.safeParse(json.body);
      if (!input.success) return invalidInput(c, input.error);
      const issues = flagIssues(input.data.models);
      if (issues.length > 0) return invalidInput(c, { issues });
      try {
        return c.json(profiles.create(input.data), 201);
      } catch (error) {
        return repositoryError(c, error);
      }
    })
    .get("/:id", (c) => {
      const profile = profiles.get(c.req.param("id"));
      return profile ? c.json(profile) : notFound(c, `agent profile ${c.req.param("id")}`);
    })
    .patch("/:id", async (c) => {
      const json = await readJson(c);
      if (!json.ok) return invalidJson(c);
      const patch = AgentProfileUpdate.safeParse(json.body);
      if (!patch.success) return invalidInput(c, patch.error);
      const issues = flagIssues(patch.data.models);
      if (issues.length > 0) return invalidInput(c, { issues });
      try {
        const profile = profiles.update(c.req.param("id"), patch.data);
        return profile ? c.json(profile) : notFound(c, `agent profile ${c.req.param("id")}`);
      } catch (error) {
        return repositoryError(c, error);
      }
    })
    .delete("/:id", (c) => {
      try {
        return profiles.delete(c.req.param("id"))
          ? c.body(null, 204)
          : notFound(c, `agent profile ${c.req.param("id")}`);
      } catch (error) {
        return repositoryError(c, error);
      }
    });
}
