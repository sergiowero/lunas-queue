// Task routes and their DAG (ADR 0010). Validation lives in @lunasq/schemas and the
// rules in TaskRepository; here only their errors are translated into HTTP codes.
import {
  type RunRepository,
  type TaskRepository,
  TaskRepositoryError,
  type TransitionTaskResult,
} from "@lunasq/db";
import {
  InstructionUpdate,
  PhaseInstructionInput,
  type Task,
  TaskCancel,
  TaskCreate,
  type TaskDetail,
  TaskListQuery,
  TaskUpdate,
} from "@lunasq/schemas";
import { type Context, Hono } from "hono";
import { invalidInput, invalidJson, notFound, readJson, readOptionalJson } from "./http.ts";

// Body or route references that do not exist: the request is valid but not applicable.
const UNPROCESSABLE = new Set(["project_not_found", "dependency_not_found", "caused_by_not_found"]);

function repositoryError(c: Context, error: unknown) {
  if (!(error instanceof TaskRepositoryError) || error.code === "invalid_row") throw error;
  const body = { error: error.code, message: error.message, cycle: error.cycle };
  return c.json(body, UNPROCESSABLE.has(error.code) ? 422 : 409);
}

function transitionError(c: Context, result: Extract<TransitionTaskResult, { ok: false }>) {
  if (result.error.code === "task_not_found") return notFound(c, `task ${c.req.param("id")}`);
  return c.json({ error: result.error.code, message: result.error.message }, 409);
}

function instructionWhat(c: Context): string {
  return `instruction ${c.req.param("instructionId")} of task ${c.req.param("id")}`;
}

export function taskRoutes(tasks: TaskRepository, runs: RunRepository): Hono {
  // Single-task responses carry the phase instructions so the UI never loses them on a refresh.
  const detail = (task: Task): TaskDetail => ({
    ...task,
    instructions: tasks.instructions(task.id) ?? [],
  });
  return new Hono()
    .get("/", (c) => {
      const query = TaskListQuery.safeParse(c.req.query());
      if (!query.success) return invalidInput(c, query.error);
      return c.json(tasks.list(query.data));
    })
    .post("/", async (c) => {
      const json = await readJson(c);
      if (!json.ok) return invalidJson(c);
      const input = TaskCreate.safeParse(json.body);
      if (!input.success) return invalidInput(c, input.error);
      try {
        return c.json(detail(tasks.create(input.data)), 201);
      } catch (error) {
        return repositoryError(c, error);
      }
    })
    .get("/:id", (c) => {
      const task = tasks.get(c.req.param("id"));
      return task ? c.json(detail(task)) : notFound(c, `task ${c.req.param("id")}`);
    })
    .patch("/:id", async (c) => {
      const json = await readJson(c);
      if (!json.ok) return invalidJson(c);
      const patch = TaskUpdate.safeParse(json.body);
      if (!patch.success) return invalidInput(c, patch.error);
      try {
        const task = tasks.update(c.req.param("id"), patch.data);
        return task ? c.json(detail(task)) : notFound(c, `task ${c.req.param("id")}`);
      } catch (error) {
        return repositoryError(c, error);
      }
    })
    .post("/:id/cancel", async (c) => {
      const json = await readOptionalJson(c);
      if (!json.ok) return invalidJson(c);
      const input = TaskCancel.safeParse(json.body);
      if (!input.success) return invalidInput(c, input.error);
      const result = tasks.cancel(c.req.param("id"), input.data.note);
      if (!result.ok) return transitionError(c, result);
      const task = tasks.get(result.task.id);
      return task ? c.json(detail(task)) : notFound(c, `task ${c.req.param("id")}`);
    })
    .post("/:id/pause", (c) => {
      // The REST API does not authenticate the caller: it is the human's local channel (like cancel and resume).
      // That only the human pauses (AC-3) is enforced by the domain: this route always emits with actor human.
      const id = c.req.param("id");
      // Delivery runs with the verifier's Run open and its pass saved: it is not paused.
      const result = tasks.pause(id, runs.deliveryInProgress(id));
      if (!result.ok) return transitionError(c, result);
      const task = tasks.get(result.task.id);
      return task ? c.json(detail(task)) : notFound(c, `task ${c.req.param("id")}`);
    })
    .post("/:id/resume", (c) => {
      const result = tasks.resume(c.req.param("id"));
      if (!result.ok) return transitionError(c, result);
      const task = tasks.get(result.task.id);
      return task ? c.json(detail(task)) : notFound(c, `task ${c.req.param("id")}`);
    })
    .post("/:id/instructions", async (c) => {
      const json = await readJson(c);
      if (!json.ok) return invalidJson(c);
      const input = PhaseInstructionInput.safeParse(json.body);
      if (!input.success) return invalidInput(c, input.error);
      try {
        const instruction = tasks.addInstruction(c.req.param("id"), input.data);
        return instruction ? c.json(instruction, 201) : notFound(c, `task ${c.req.param("id")}`);
      } catch (error) {
        return repositoryError(c, error);
      }
    })
    .patch("/:id/instructions/:instructionId", async (c) => {
      const json = await readJson(c);
      if (!json.ok) return invalidJson(c);
      const patch = InstructionUpdate.safeParse(json.body);
      if (!patch.success) return invalidInput(c, patch.error);
      const instruction = tasks.updateInstruction(
        c.req.param("id"),
        c.req.param("instructionId"),
        patch.data,
      );
      return instruction ? c.json(instruction) : notFound(c, instructionWhat(c));
    })
    .delete("/:id/instructions/:instructionId", (c) =>
      tasks.removeInstruction(c.req.param("id"), c.req.param("instructionId"))
        ? c.body(null, 204)
        : notFound(c, instructionWhat(c)),
    )
    .get("/:id/dependencies", (c) => {
      const dependencies = tasks.dependencies(c.req.param("id"));
      return dependencies ? c.json(dependencies) : notFound(c, `task ${c.req.param("id")}`);
    })
    .put("/:id/dependencies/:dependsOnId", (c) => {
      try {
        const result = tasks.addDependency(c.req.param("id"), c.req.param("dependsOnId"));
        if (!result) return notFound(c, `task ${c.req.param("id")}`);
        return c.json(result, result.created ? 201 : 200);
      } catch (error) {
        return repositoryError(c, error);
      }
    })
    .delete("/:id/dependencies/:dependsOnId", (c) => {
      try {
        const result = tasks.removeDependency(c.req.param("id"), c.req.param("dependsOnId"));
        if (!result) return notFound(c, `task ${c.req.param("id")}`);
        return result.removed
          ? c.body(null, 204)
          : notFound(c, `dependency of task ${c.req.param("id")} on ${c.req.param("dependsOnId")}`);
      } catch (error) {
        return repositoryError(c, error);
      }
    });
}
