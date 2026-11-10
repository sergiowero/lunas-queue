import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGit, FakeGitHub, FakeHerdr, FakeProcessRunner, type FakeTree } from "@lunasq/adapters";
import { createQuestion, listEvents, openDatabase, RunRepository } from "@lunasq/db";
import { insertProject, insertRun, insertTask } from "@lunasq/db/test-helpers";
import { taskBranch } from "@lunasq/domain";
import { HOOK_POINT_COMPLETED } from "@lunasq/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SUBAGENT_HOOK_PATH } from "../subagents/routes.ts";
import { prepareDatabase, type RuntimeOptions, startRuntime, telemetryEnv } from "./runtime.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

function options(overrides: Partial<RuntimeOptions> = {}): RuntimeOptions & { dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "lunasq-runtime-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    dbPath: join(dir, "lunasq.db"),
    port: 0,
    mcpConfigPath: join(dir, "mcp.json"),
    hookSettingsPath: join(dir, "claude-settings.json"),
    adapters: {
      herdr: new FakeHerdr(),
      github: new FakeGitHub(),
      git: new FakeGit(),
      processes: new FakeProcessRunner(),
    },
    ...overrides,
  };
}

/** The project's base branch on the (fake) remote, where the hooks of each point are read from. */
function seedBase(
  opts: RuntimeOptions,
  project: { localPath: string; baseBranch: string },
  tree: FakeTree = {},
) {
  const git = opts.adapters?.git as FakeGit;
  git.addCheckout(project.localPath, { branch: project.baseBranch, tree });
}

/** An executable hook script that succeeds, as the base branch holds it. */
const hookScript = { content: "#!/bin/sh\nexit 0\n", executable: true };

/**
 * A runtime over fakes whose project has one hook script at `point` on its base branch, the task's
 * worktree checkout in the fake git, and a fake runner for the scripts (the fake herdr's worktree path is not a
 * real directory).
 */
function hookedRuntime(point: string) {
  const runner = new FakeProcessRunner();
  const opts = options({ hookRunnerFor: () => runner });
  const seed = prepareDatabase(opts.dbPath);
  const project = insertProject(seed);
  const tree = { [`lunasq/hooks/${point}/10-script`]: hookScript };
  seedBase(opts, project, tree);
  const created = insertTask(seed, project.id);
  seed.$client.close();
  const git = opts.adapters?.git as FakeGit;
  git.addCheckout(`~/.herdr/worktrees/${taskBranch(created.id).replaceAll("/", "-")}`, {
    branch: taskBranch(created.id),
    tree,
  });
  let db: ReturnType<typeof openDatabase> | undefined;
  const open = () => {
    if (!db) {
      const opened = openDatabase(opts.dbPath);
      db = opened;
      cleanups.push(() => {
        opened.$client.close();
      });
    }
    return db;
  };
  return {
    opts,
    runner,
    task: () => created,
    db: open,
    runs: () => new RunRepository(open()),
  };
}

async function start(opts: RuntimeOptions) {
  const runtime = await startRuntime(opts);
  cleanups.push(() => runtime.stop());
  return runtime;
}

/** IPv4 of an external interface of this machine; undefined if there is no network (e.g. a sandbox). */
function lanAddress(): string | undefined {
  for (const list of Object.values(networkInterfaces())) {
    const found = list?.find((i) => i.family === "IPv4" && !i.internal);
    if (found) return found.address;
  }
  return undefined;
}

/** Raw PUT with a localhost Host: fetch does not let you choose the connection's origin nor the Host. */
function putProviders(host: string, port: number, body: object) {
  return new Promise<number>((resolve, reject) => {
    const req = request(
      {
        host,
        port,
        path: "/api/settings/providers",
        method: "PUT",
        headers: { "content-type": "application/json", host: "localhost" },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

describe("telemetryEnv", () => {
  it("enables Claude Code's telemetry toward the local collector by OTLP http/json", () => {
    expect(telemetryEnv("http://127.0.0.1:7360")).toEqual({
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
      OTEL_METRICS_EXPORTER: "otlp",
      OTEL_LOGS_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:7360",
      OTEL_LOG_TOOL_DETAILS: "1",
    });
  });
});

describe("prepareDatabase", () => {
  it("creates the database with its migrations and repeating it changes nothing", () => {
    const { dbPath } = options();
    prepareDatabase(dbPath).$client.close();
    const db = prepareDatabase(dbPath);
    const tables = db.$client
      .prepare("select name from sqlite_master where type = 'table' and name = 'projects'")
      .all();
    db.$client.close();
    expect(tables).toHaveLength(1);
  });
});

describe("startRuntime", () => {
  it("serves the front end build from the same URL when it gets webRoot", async () => {
    const opts = options();
    const webRoot = join(opts.dir, "web");
    mkdirSync(webRoot);
    writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>LunasQ</title>");
    const runtime = await start({ ...opts, webRoot });

    const home = await fetch(`${runtime.url}/queue`);
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("<title>LunasQ</title>");
    expect((await fetch(`${runtime.url}/api/projects`)).status).toBe(200);
  });

  it("passes the PR poll and scheduler cadence: an invalid one prevents starting", async () => {
    await expect(startRuntime(options({ prPollIntervalMs: 10 }))).rejects.toThrow(
      "intervalMs must be an integer >= 1000",
    );
    await expect(startRuntime(options({ scheduler: { tickIntervalMs: 10 } }))).rejects.toThrow();
    const runtime = await start(
      options({ prPollIntervalMs: 1_000, scheduler: { tickIntervalMs: 1_000 } }),
    );
    expect((await fetch(`${runtime.url}/api/queue`)).status).toBe(200);
  });

  it("without webRoot it serves no static files", async () => {
    const runtime = await start(options());
    expect((await fetch(`${runtime.url}/queue`)).status).toBe(404);
  });

  it("serves the API on localhost and writes the MCP and hooks files with its URL", async () => {
    const opts = options();
    const runtime = await start(opts);

    expect(runtime.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const res = await fetch(`${runtime.url}/api/projects`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);

    const mcp = JSON.parse(readFileSync(opts.mcpConfigPath, "utf8"));
    expect(mcp.mcpServers.lunasq.url).toBe(`${runtime.url}/mcp`);
    const settings = readFileSync(opts.hookSettingsPath, "utf8");
    expect(settings).toContain(`${runtime.url}${SUBAGENT_HOOK_PATH}`);
  });

  it("passes telemetry to each pane's environment unless it is turned off", async () => {
    const opts = options();
    const seed = prepareDatabase(opts.dbPath);
    const project = insertProject(seed);
    seedBase(opts, project);
    const task = insertTask(seed, project.id);
    seed.$client.close();
    const herdr = opts.adapters?.herdr as FakeHerdr;

    const on = await start(opts);

    const db = openDatabase(opts.dbPath);
    cleanups.push(() => {
      db.$client.close();
    });
    const runs = new RunRepository(db);
    await vi.waitFor(() => expect(runs.forTask(task.id)[0]?.herdrPane).toBeTruthy());
    const pane = runs.forTask(task.id)[0]?.herdrPane as string;
    expect(herdr.paneEnv(pane)).toMatchObject(telemetryEnv(on.url));

    // The OTLP endpoint answers with the flag on: an unknown token has no effects.
    const logs = (url: string) => fetch(`${url}/v1/logs`, { method: "POST", body: "{}" });
    expect((await logs(on.url)).status).toBe(200);

    const off = await start(options({ telemetry: false }));
    expect(off.paneEnv).not.toHaveProperty("CLAUDE_CODE_ENABLE_TELEMETRY");
    expect((await logs(off.url)).status).toBe(404);
  });

  it("mounts the notifications stream", async () => {
    const runtime = await start(options());
    const controller = new AbortController();
    const res = await fetch(`${runtime.url}/api/notifications/stream`, {
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    controller.abort();
  });

  it("wires the inbox: blocked agents, their access in herdr and answering questions", async () => {
    const opts = options();
    const seed = prepareDatabase(opts.dbPath);
    const project = insertProject(seed);
    seedBase(opts, project);
    const task = insertTask(seed, project.id);
    const waiting = insertTask(seed, project.id, {
      state: "in_progress",
      subState: "waiting_human",
    });
    const question = createQuestion(seed, {
      taskId: waiting.id,
      runId: insertRun(seed, waiting.id).id,
      question: "¿Borro la tabla?",
      context: "hay dos",
    });
    seed.$client.close();
    const herdr = opts.adapters?.herdr as FakeHerdr;
    const runtime = await start(opts);
    const db = openDatabase(opts.dbPath);
    cleanups.push(() => {
      db.$client.close();
    });
    const runs = new RunRepository(db);
    await vi.waitFor(() => expect(runs.forTask(task.id)[0]?.herdrName).toBeTruthy());
    const run = runs.forTask(task.id)[0];
    const name = run?.herdrName as string;

    herdr.setAgentStatus(name, "blocked");
    await vi.waitFor(async () => {
      const blocked = await (await fetch(`${runtime.url}/api/blocked`)).json();
      expect(blocked).toEqual([expect.objectContaining({ runId: run?.id, agentName: name })]);
    });
    const focus = await fetch(`${runtime.url}/api/blocked/${run?.id}/focus`, { method: "POST" });
    expect(focus.status).toBe(204);
    expect(herdr.focused).toBe(name);

    const answer = await fetch(`${runtime.url}/api/questions/${question.id}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answer: "sí" }),
    });
    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({ delivery: "new_run" });
  });

  it("focuses in herdr the agent of a Run dispatched from the Runs table", async () => {
    const opts = options();
    const seed = prepareDatabase(opts.dbPath);
    const project = insertProject(seed);
    seedBase(opts, project);
    const task = insertTask(seed, project.id);
    seed.$client.close();
    const herdr = opts.adapters?.herdr as FakeHerdr;
    const runtime = await start(opts);
    const db = openDatabase(opts.dbPath);
    cleanups.push(() => {
      db.$client.close();
    });
    const runs = new RunRepository(db);
    await vi.waitFor(() => expect(runs.forTask(task.id)[0]?.herdrPane).toBeTruthy());
    const run = runs.forTask(task.id)[0];

    const res = await fetch(`${runtime.url}/api/runs/${run?.id}/focus`, { method: "POST" });
    expect(res.status).toBe(204);
    expect(herdr.focused).toBe(run?.herdrName);
  });

  it("runs the project's before_refinement hooks with the Run id before the agent is started", async () => {
    const { opts, runner, task, runs, db } = hookedRuntime("before_refinement");
    await start(opts);

    await vi.waitFor(() => expect(runs().forTask(task().id)[0]?.herdrPane).toBeTruthy());
    const run = runs().forTask(task().id)[0];

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.env).toMatchObject({
      LUNASQ_HOOK_POINT: "before_refinement",
      LUNASQ_RUN_ID: run?.id,
    });
    const point = listEvents(db(), task().id).find((e) => e.type === HOOK_POINT_COMPLETED);
    expect(point?.payload).toMatchObject({ point: "before_refinement", runId: run?.id });
  });

  it("a Run that fails runs the project's on_failure hooks with its id and reason", async () => {
    const { opts, runner, task, runs } = hookedRuntime("on_failure");
    await start(opts);
    await vi.waitFor(() => expect(runs().forTask(task().id)[0]?.herdrPane).toBeTruthy());
    const run = runs().forTask(task().id)[0];
    expect(runner.calls).toHaveLength(0);

    runs().fail(run?.id as string, "the agent crashed");

    // The outbox publisher polls once a second.
    await vi.waitFor(() => expect(runner.calls).toHaveLength(1), { timeout: 5_000 });
    expect(runner.calls[0]?.env).toMatchObject({
      LUNASQ_HOOK_POINT: "on_failure",
      LUNASQ_RUN_ID: run?.id,
      LUNASQ_PHASE_RESULT: "the agent crashed",
    });
  });

  it("stop closes the server and is idempotent", async () => {
    const runtime = await startRuntime(options());
    await runtime.stop();
    await runtime.stop();
    await expect(fetch(`${runtime.url}/api/projects`)).rejects.toThrow();
  });

  it("if the composition fails, it frees the port and the database", async () => {
    const opts = options();
    const first = await start(options());
    const port = Number(new URL(first.url).port);
    await first.stop();
    const broken = {
      get herdr(): FakeHerdr {
        throw new Error("herdr roto");
      },
    };
    await expect(startRuntime({ ...opts, port, adapters: broken })).rejects.toThrow("herdr roto");
    const again = await start({ ...opts, port });
    expect(again.url).toBe(first.url);
  });

  it("fails if the port is busy", async () => {
    const first = await start(options());
    const port = Number(new URL(first.url).port);
    await expect(startRuntime(options({ port }))).rejects.toThrow(/EADDRINUSE/);
  });

  // It goes through the real server: app.request injects the connection by hand and does not prove the runtime
  // forwards it to the loopback guard.
  it.skipIf(lanAddress() === undefined)(
    "with the server on all interfaces, it rejects the settings PUT that arrives over the network even if it forges Host: localhost",
    async () => {
      const runtime = await start(options({ hostname: "0.0.0.0" }));
      const port = Number(new URL(runtime.url).port);

      expect(await putProviders(lanAddress() ?? "", port, { claude: false })).toBe(403);
      expect(await putProviders("127.0.0.1", port, { claude: true })).toBe(200);
    },
  );
});
