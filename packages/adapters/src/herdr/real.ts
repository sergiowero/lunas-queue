// Adapter real de herdr: operaciones por el CLI con salida JSON y eventos por el socket Unix
// (docs/tech-stack.md). Aplica las diferencias con el diseño de ADR 0004: `worktree list`/`open`
// antes de `create`, env por `pane split`, suscripción por pane, `seq` monotónico en metadata y
// cierre de stream tratado como pérdida de eventos.
import { homedir } from "node:os";
import { join } from "node:path";
import { HerdrCli, type HerdrCliOptions } from "./cli.ts";
import { isHerdrError } from "./errors.ts";
import { EventStream } from "./socket.ts";
import type {
  AgentStatus,
  HerdrAdapter,
  HerdrAgent,
  HerdrEvent,
  HerdrSnapshot,
  HerdrSubscription,
  SubscribeInput,
} from "./types.ts";
import {
  agentInfoWire,
  notificationWire,
  paneInfoWire,
  snapshotWire,
  toAgent,
  toPane,
  toSnapshot,
  toWorkspace,
  toWorktree,
  workspaceCreatedWire,
  worktreeListWire,
  worktreeOpenedWire,
} from "./wire.ts";

const SETTLED: AgentStatus[] = ["idle", "done"];

/** `--source` con el que LunasQ publica metadata en los panes. */
export const METADATA_SOURCE = "lunasq";

const LIFECYCLE_SUBSCRIPTIONS = [
  "pane.closed",
  "pane.exited",
  "workspace.closed",
  "worktree.created",
  "worktree.removed",
].map((type) => ({ type }));

export interface RealHerdrOptions extends HerdrCliOptions {
  /** Socket de la sesión; por defecto el de `~/.config/herdr` para `session`. */
  socketPath?: string;
  backoff?: { initialMs: number; maxMs: number };
}

export function defaultSocketPath(session?: string): string {
  const base = join(homedir(), ".config", "herdr");
  return session ? join(base, "sessions", session, "herdr.sock") : join(base, "herdr.sock");
}

export class RealHerdr implements HerdrAdapter {
  private readonly cli: HerdrCli;
  private readonly socketPath: string;
  private readonly backoff: { initialMs: number; maxMs: number } | undefined;
  private readonly streams = new Set<EventStream>();
  private lastSeq = 0;

  constructor(opts: RealHerdrOptions = {}) {
    this.cli = new HerdrCli(opts);
    this.socketPath = opts.socketPath ?? defaultSocketPath(opts.session);
    this.backoff = opts.backoff;
  }

  async ensureWorkspace(input: {
    cwd: string;
    label: string;
    workspaceId?: string;
    env?: Record<string, string>;
  }) {
    const snap = await this.snapshot();
    const existing =
      snap.workspaces.find((w) => w.workspaceId === input.workspaceId) ??
      snap.workspaces.find((w) => !w.linkedWorktree && w.label === input.label);
    const rootPane = existing && snap.panes.find((p) => p.workspaceId === existing.workspaceId);
    if (existing && rootPane) {
      return { workspace: existing, rootPaneId: rootPane.paneId, created: false };
    }
    const args = ["workspace", "create", "--cwd", input.cwd, "--label", input.label, "--no-focus"];
    const res = workspaceCreatedWire.parse(await this.cli.json([...args, ...envArgs(input.env)]));
    return {
      workspace: toWorkspace(res.workspace),
      rootPaneId: res.root_pane.pane_id,
      created: true,
    };
  }

  async closeWorkspace(workspaceId: string) {
    await ignoring("workspace_not_found", this.cli.json(["workspace", "close", workspaceId]));
  }

  async ensureWorktree(input: {
    workspaceId: string;
    branch: string;
    base: string;
    path?: string;
    label?: string;
  }) {
    const ws = ["--workspace", input.workspaceId];
    const label = input.label ? ["--label", input.label] : [];
    const list = worktreeListWire.parse(await this.cli.json(["worktree", "list", ...ws]));
    if (list.worktrees.some((w) => w.branch === input.branch)) {
      // `open` es idempotente: si ya está abierto devuelve el mismo workspace.
      const args = ["worktree", "open", ...ws, "--branch", input.branch, ...label, "--no-focus"];
      const res = worktreeOpenedWire.parse(await this.cli.json(args));
      return { worktree: toWorktree(res, input.branch), created: false };
    }
    const args = [
      ...["worktree", "create", ...ws, "--branch", input.branch, "--base", input.base],
      ...(input.path ? ["--path", input.path] : []),
      ...label,
      "--no-focus",
    ];
    const res = worktreeOpenedWire.parse(await this.cli.json(args));
    return { worktree: toWorktree(res, input.branch), created: true };
  }

  async removeWorktree(input: { workspaceId: string; force?: boolean }) {
    const force = input.force ? ["--force"] : [];
    await this.cli.json(["worktree", "remove", "--workspace", input.workspaceId, ...force]);
  }

  async splitPane(input: {
    paneId: string;
    direction?: "right" | "down";
    cwd?: string;
    env?: Record<string, string>;
  }) {
    const args = [
      ...["pane", "split", input.paneId, "--direction", input.direction ?? "right"],
      ...(input.cwd ? ["--cwd", input.cwd] : []),
      ...envArgs(input.env),
      "--no-focus",
    ];
    return toPane(paneInfoWire.parse(await this.cli.json(args)).pane);
  }

  async closePane(paneId: string) {
    await ignoring("pane_not_found", this.cli.json(["pane", "close", paneId]));
  }

  async startAgent(input: {
    name: string;
    kind: string;
    paneId: string;
    args?: string[];
    timeoutMs?: number;
  }) {
    const existing = await this.getAgent(input.name);
    if (existing) return { agent: existing, started: false };
    const args = [
      ...["agent", "start", input.name, "--kind", input.kind, "--pane", input.paneId],
      ...(input.timeoutMs ? ["--timeout", String(input.timeoutMs)] : []),
      ...(input.args?.length ? ["--", ...input.args] : []),
    ];
    try {
      return {
        agent: toAgent(agentInfoWire.parse(await this.cli.json(args)).agent),
        started: true,
      };
    } catch (err) {
      // `agent_not_ready`: arrancó pero quedó bloqueado (p. ej. diálogo de confianza, ADR 0004).
      // `agent_name_taken`: otro despacho lo arrancó entre el `get` y el `start`.
      if (!isHerdrError(err, "agent_not_ready") && !isHerdrError(err, "agent_name_taken"))
        throw err;
      const agent = await this.getAgent(input.name);
      if (!agent) throw err;
      return { agent, started: isHerdrError(err, "agent_not_ready") };
    }
  }

  async getAgent(name: string): Promise<HerdrAgent | undefined> {
    const res = await ignoring("agent_not_found", this.cli.json(["agent", "get", name]));
    return res === undefined ? undefined : toAgent(agentInfoWire.parse(res).agent);
  }

  async promptAgent(input: {
    name: string;
    text: string;
    wait?: { timeoutMs: number; until?: AgentStatus[] };
  }) {
    // El texto va como posicional: herdr lo acepta aunque empiece con `-`, pero no detrás de `--`.
    const wait = input.wait
      ? [
          "--wait",
          ...untilArgs(input.wait.until ?? SETTLED),
          "--timeout",
          String(input.wait.timeoutMs),
        ]
      : [];
    const res = await this.cli.json(["agent", "prompt", input.name, input.text, ...wait]);
    return toAgent(agentInfoWire.parse(res).agent);
  }

  async waitAgent(input: { name: string; until?: AgentStatus[]; timeoutMs?: number }) {
    const args = [
      ...["agent", "wait", input.name, ...untilArgs(input.until ?? SETTLED)],
      ...(input.timeoutMs !== undefined ? ["--timeout", String(input.timeoutMs)] : []),
    ];
    return toAgent(agentInfoWire.parse(await this.cli.json(args)).agent);
  }

  async readAgent(input: { name: string; lines?: number }) {
    const lines = input.lines !== undefined ? ["--lines", String(input.lines)] : [];
    return this.cli.text(["agent", "read", input.name, ...lines]);
  }

  async reportMetadata(input: { paneId: string; title?: string; tokens?: Record<string, string> }) {
    // herdr descarta en silencio un `seq` <= al último visto por `--source` (ADR 0004). Se deriva
    // del reloj para seguir siendo creciente aunque el proceso reinicie.
    this.lastSeq = Math.max(Date.now(), this.lastSeq + 1);
    const args = [
      ...["pane", "report-metadata", input.paneId, "--source", METADATA_SOURCE],
      ...(input.title !== undefined ? ["--title", input.title] : []),
      ...Object.entries(input.tokens ?? {}).flatMap(([k, v]) => ["--token", `${k}=${v}`]),
      ...["--seq", String(this.lastSeq)],
    ];
    await this.cli.text(args);
  }

  async notify(input: { title: string; body?: string; sound?: "none" | "done" | "request" }) {
    const args = [
      ...["notification", "show", input.title],
      ...(input.body !== undefined ? ["--body", input.body] : []),
      ...(input.sound ? ["--sound", input.sound] : []),
    ];
    const res = notificationWire.parse(await this.cli.json(args));
    return { shown: res.shown, ...(res.reason != null && { reason: res.reason }) };
  }

  async snapshot(): Promise<HerdrSnapshot> {
    return toSnapshot(snapshotWire.parse(await this.cli.json(["api", "snapshot"])));
  }

  subscribe(input: SubscribeInput, onEvent: (event: HerdrEvent) => void): HerdrSubscription {
    const subscriptions = [
      ...(input.paneIds ?? []).map((pane_id) => ({ type: "pane.agent_status_changed", pane_id })),
      ...(input.lifecycle ? LIFECYCLE_SUBSCRIPTIONS : []),
    ];
    if (subscriptions.length === 0) throw new Error("subscribe: indica paneIds o lifecycle");
    const stream = new EventStream({
      socketPath: this.socketPath,
      subscriptions,
      onEvent,
      ...(this.backoff && { backoff: this.backoff }),
    });
    this.streams.add(stream);
    return {
      close: async () => {
        this.streams.delete(stream);
        await stream.close();
      },
    };
  }

  /** Corta los streams abiertos como si herdr los cerrara. Solo para tests. */
  dropStreams() {
    for (const stream of this.streams) stream.drop();
  }
}

function envArgs(env: Record<string, string> | undefined) {
  return Object.entries(env ?? {}).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
}

function untilArgs(until: AgentStatus[]) {
  return until.flatMap((s) => ["--until", s]);
}

/** Resuelve `undefined` si la operación falla con `code` (para operaciones idempotentes). */
async function ignoring<T>(code: string, op: Promise<T>): Promise<T | undefined> {
  try {
    return await op;
  } catch (err) {
    if (isHerdrError(err, code)) return undefined;
    throw err;
  }
}
