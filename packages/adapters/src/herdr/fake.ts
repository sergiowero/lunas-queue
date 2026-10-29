// Fake en memoria del adapter de herdr. Reproduce el comportamiento observado en herdr 0.9.5
// (ADR 0004): ids opacos `wN`, `wN:tN`, `wN:pN`; worktrees que sobreviven como branch tras
// `remove`; eventos por pane; notificaciones apagadas por defecto. Cumple la suite de contrato.
import { type ChildProcess, spawn } from "node:child_process";
import { TRUST_DIALOG_MARKER } from "./claude-tui.ts";
import { HerdrError } from "./errors.ts";
import type {
  AgentSessionInfo,
  AgentStatus,
  HerdrAdapter,
  HerdrAgent,
  HerdrEvent,
  HerdrPane,
  HerdrSnapshot,
  HerdrSubscription,
  HerdrWorkspace,
  HerdrWorktree,
  SubscribeInput,
} from "./types.ts";

const SETTLED: AgentStatus[] = ["idle", "done"];

// Pantalla del diálogo como la captura `spikes/herdr/outputs/09-agent-read-blocked.txt`: el
// cursor arranca en "No, exit", así que un Enter a secas cierra Claude Code.
const trustDialog = (cursor: number) =>
  [
    " Quick safety check: Is this a project you created or",
    " one you trust?",
    ` ${cursor === 0 ? "❯" : " "} No, exit`,
    ` ${cursor === 1 ? "❯" : " "} ${TRUST_DIALOG_MARKER}`,
    " Enter to confirm · Esc to cancel",
  ].join("\n");

interface FakeWorkspace extends HerdrWorkspace {
  /** Checkout que abre el workspace; herdr solo lo publica para worktrees (ADR 0004, adenda). */
  repoPath: string;
  tabId: string;
  nextPane: number;
}

interface FakePane extends HerdrPane {
  env: Record<string, string>;
  /** Comandos lanzados con `runInPane`; cerrar el pane los mata. */
  processes: ChildProcess[];
  title?: string;
  tokens: Record<string, string>;
}

interface FakeAgent {
  name: string;
  kind: string;
  paneId: string;
  status: AgentStatus;
  args: string[];
  transcript: string[];
  session?: AgentSessionInfo;
  /** Posición del cursor en el diálogo de confianza, mientras se muestra. */
  trustCursor?: number;
  keys: string[][];
}

interface FakeWorktree {
  path: string;
  workspaceId?: string;
  /** Cambios sin commit: `remove` exige `force`. */
  dirty?: boolean;
}

interface FakeSubscription {
  input: SubscribeInput;
  onEvent: (event: HerdrEvent) => void;
  closed: boolean;
}

export interface FakeHerdrOptions {
  /** Cuánto tarda un prompt en pasar de `working` a `done`. */
  promptDurationMs?: number;
  /** Simula `[ui.toast] delivery`; herdr lo trae apagado por defecto. */
  notificationsEnabled?: boolean;
  /**
   * Estado con que arrancan los agentes. `blocked` simula el diálogo de confianza de carpeta de
   * Claude Code en un worktree nuevo (ADR 0004); herdr real responde `agent_not_ready`.
   */
  startStatus?: "idle" | "blocked";
}

export class FakeHerdr implements HerdrAdapter {
  private readonly promptDurationMs: number;
  private readonly notificationsEnabled: boolean;
  private readonly startStatus: "idle" | "blocked";
  private nextWorkspace = 1;
  private readonly workspaces = new Map<string, FakeWorkspace>();
  private readonly panes = new Map<string, FakePane>();
  private readonly agents = new Map<string, FakeAgent>();
  /** Worktrees por repo (checkout del proyecto) y branch. */
  private readonly worktrees = new Map<string, Map<string, FakeWorktree>>();
  private readonly subscriptions = new Set<FakeSubscription>();
  private readonly statusWaiters = new Set<() => void>();

  /** Notificaciones mostradas, para que los tests las inspeccionen. */
  readonly notifications: { title: string; body?: string; sound?: string }[] = [];

  constructor(opts: FakeHerdrOptions = {}) {
    this.promptDurationMs = opts.promptDurationMs ?? 5;
    this.notificationsEnabled = opts.notificationsEnabled ?? false;
    this.startStatus = opts.startStatus ?? "idle";
  }

  async ensureWorkspace(input: {
    cwd: string;
    label: string;
    workspaceId?: string;
    env?: Record<string, string>;
  }) {
    const known = input.workspaceId ? this.workspaces.get(input.workspaceId) : undefined;
    const existing =
      known ??
      [...this.workspaces.values()].find((w) => !w.linkedWorktree && w.label === input.label);
    if (existing) {
      return {
        workspace: toWorkspace(existing),
        rootPaneId: this.rootPane(existing),
        created: false,
      };
    }
    // Como herdr real (snapshot y luego create): dos llamadas concurrentes crean dos workspaces.
    await Promise.resolve();
    const ws = this.createWorkspace(input.label, input.cwd, false, input.env ?? {});
    return { workspace: toWorkspace(ws), rootPaneId: this.rootPane(ws), created: true };
  }

  async closeWorkspace(workspaceId: string) {
    this.removeWorkspace(workspaceId);
  }

  private removeWorkspace(workspaceId: string) {
    // Se borra primero para que cerrar su último pane no vuelva a cerrarlo.
    if (!this.workspaces.delete(workspaceId)) return;
    for (const pane of [...this.panes.values()]) {
      if (pane.workspaceId === workspaceId) this.removePane(pane.paneId);
    }
    for (const repo of this.worktrees.values()) {
      for (const wt of repo.values()) if (wt.workspaceId === workspaceId) delete wt.workspaceId;
    }
    this.emit({ type: "workspace_closed", workspaceId });
  }

  async ensureWorktree(input: {
    workspaceId: string;
    branch: string;
    base: string;
    path?: string;
    label?: string;
  }) {
    const project = this.workspaces.get(input.workspaceId);
    if (!project) {
      throw new HerdrError("workspace_not_found", `workspace ${input.workspaceId} not found`);
    }
    const repo = this.worktrees.get(project.repoPath) ?? new Map<string, FakeWorktree>();
    this.worktrees.set(project.repoPath, repo);
    const label = input.label ?? input.branch;

    const existing = repo.get(input.branch);
    if (existing) {
      const open = existing.workspaceId ? this.workspaces.get(existing.workspaceId) : undefined;
      const ws = open ?? this.createWorkspace(label, existing.path, true, {});
      existing.workspaceId = ws.workspaceId;
      return { worktree: this.toWorktree(ws, input.branch, existing.path), created: false };
    }

    // Como herdr real (list y luego create): un create concurrente del mismo branch falla.
    await Promise.resolve();
    if (repo.has(input.branch)) {
      throw new HerdrError("worktree_create_failed", `branch ${input.branch} already exists`);
    }
    const path = input.path ?? `~/.herdr/worktrees/${input.branch.replaceAll("/", "-")}`;
    const ws = this.createWorkspace(label, path, true, {});
    repo.set(input.branch, { path, workspaceId: ws.workspaceId });
    this.emit({ type: "worktree_created", workspaceId: ws.workspaceId });
    return { worktree: this.toWorktree(ws, input.branch, path), created: true };
  }

  async listWorktrees(workspaceId: string) {
    const project = this.workspaces.get(workspaceId);
    if (!project) throw new HerdrError("workspace_not_found", `workspace ${workspaceId} not found`);
    const repo = this.worktrees.get(project.repoPath) ?? new Map<string, FakeWorktree>();
    return [...repo].map(([branch, wt]) => ({
      branch,
      path: wt.path,
      ...(wt.workspaceId && { workspaceId: wt.workspaceId }),
    }));
  }

  async removeWorktree(input: { workspaceId: string; force?: boolean }) {
    const ws = this.workspaces.get(input.workspaceId);
    if (!ws) return;
    if (!ws.linkedWorktree) {
      throw new HerdrError(
        "not_linked_worktree",
        `workspace ${input.workspaceId} is not a linked worktree`,
      );
    }
    for (const repo of this.worktrees.values()) {
      for (const wt of repo.values()) {
        if (wt.workspaceId === input.workspaceId && wt.dirty && !input.force) {
          throw new HerdrError(
            "dirty_worktree_requires_force",
            `'${wt.path}' contains modified or untracked files, use --force to delete it`,
          );
        }
      }
    }
    for (const repo of this.worktrees.values()) {
      for (const [branch, wt] of repo)
        if (wt.workspaceId === input.workspaceId) repo.delete(branch);
    }
    this.removeWorkspace(input.workspaceId);
    this.emit({ type: "worktree_removed", workspaceId: input.workspaceId });
  }

  async splitPane(input: {
    paneId: string;
    direction?: "right" | "down";
    cwd?: string;
    env?: Record<string, string>;
  }) {
    const parent = this.requirePane(input.paneId);
    const ws = this.workspaces.get(parent.workspaceId);
    if (!ws)
      throw new HerdrError("workspace_not_found", `workspace ${parent.workspaceId} not found`);
    const pane = this.addPane(ws, input.cwd ?? parent.cwd, { ...parent.env, ...input.env });
    return toPane(pane);
  }

  async closePane(paneId: string) {
    if (this.panes.has(paneId)) this.removePane(paneId);
  }

  /** Como herdr: corre el comando de verdad, con `sh -c` en el cwd y el env del pane. */
  async runInPane(input: { paneId: string; command: string }) {
    const pane = this.requirePane(input.paneId);
    const child = spawn("/bin/sh", ["-c", input.command], {
      cwd: pane.cwd,
      env: { ...process.env, ...pane.env, HERDR_PANE_ID: pane.paneId },
      stdio: "ignore",
      detached: true,
    });
    child.on("error", () => {
      // El cwd ya no existe: en herdr el comando fallaría dentro del pane.
    });
    child.unref();
    pane.processes.push(child);
  }

  async startAgent(input: {
    name: string;
    kind: string;
    paneId: string;
    args?: string[];
    timeoutMs?: number;
  }) {
    const existing = this.agents.get(input.name);
    if (existing) return { agent: this.toAgent(existing), started: false };
    this.requirePane(input.paneId);
    const agent: FakeAgent = {
      name: input.name,
      kind: input.kind,
      paneId: input.paneId,
      status: this.startStatus,
      args: input.args ?? [],
      transcript: [],
      keys: [],
      ...(this.startStatus === "blocked" && { trustCursor: 0 }),
    };
    this.agents.set(input.name, agent);
    return { agent: this.toAgent(agent), started: true };
  }

  async getAgent(name: string) {
    const agent = this.agents.get(name);
    return agent ? this.toAgent(agent) : undefined;
  }

  async promptAgent(input: {
    name: string;
    text: string;
    wait?: { timeoutMs: number; until?: AgentStatus[] };
  }) {
    const agent = this.requireAgent(input.name);
    agent.transcript.push(input.text);
    this.setAgentStatus(agent.name, "working");
    setTimeout(() => {
      if (this.agents.get(agent.name) === agent && agent.status === "working") {
        this.setAgentStatus(agent.name, "done");
      }
    }, this.promptDurationMs);
    if (!input.wait) return this.toAgent(agent);
    return this.waitAgent({
      name: input.name,
      until: input.wait.until ?? SETTLED,
      timeoutMs: input.wait.timeoutMs,
    });
  }

  async waitAgent(input: { name: string; until?: AgentStatus[]; timeoutMs?: number }) {
    const until = input.until ?? SETTLED;
    const agent = this.requireAgent(input.name);
    if (until.includes(agent.status)) return this.toAgent(agent);
    return new Promise<HerdrAgent>((resolve, reject) => {
      const check = () => {
        const current = this.agents.get(input.name);
        if (!current) {
          cleanup();
          reject(new HerdrError("agent_not_found", `agent target ${input.name} not found`));
        } else if (until.includes(current.status)) {
          cleanup();
          resolve(this.toAgent(current));
        }
      };
      const timer =
        input.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              cleanup();
              reject(new HerdrError("timeout", "timed out waiting for agent status"));
            }, input.timeoutMs);
      const cleanup = () => {
        this.statusWaiters.delete(check);
        if (timer) clearTimeout(timer);
      };
      this.statusWaiters.add(check);
    });
  }

  async readAgent(input: { name: string; lines?: number }) {
    const agent = this.requireAgent(input.name);
    const screen =
      agent.trustCursor === undefined
        ? agent.transcript
        : [...agent.transcript, trustDialog(agent.trustCursor)];
    return screen.slice(-(input.lines ?? screen.length)).join("\n");
  }

  async sendKeys(input: { name: string; keys: string[] }) {
    const agent = this.requireAgent(input.name);
    agent.keys.push([...input.keys]);
    for (const key of input.keys) {
      if (agent.trustCursor === undefined) continue;
      if (key === "down") agent.trustCursor = 1;
      else if (key === "up") agent.trustCursor = 0;
      else if (key === "enter") {
        const accepted = agent.trustCursor === 1;
        delete agent.trustCursor;
        if (accepted) this.setAgentStatus(agent.name, "idle");
        else return this.exitAgent(agent.name);
      }
    }
  }

  async reportMetadata(input: { paneId: string; title?: string; tokens?: Record<string, string> }) {
    const pane = this.requirePane(input.paneId);
    if (input.title !== undefined) pane.title = input.title;
    Object.assign(pane.tokens, input.tokens);
  }

  async notify(input: { title: string; body?: string; sound?: "none" | "done" | "request" }) {
    if (!this.notificationsEnabled) return { shown: false, reason: "disabled" };
    this.notifications.push(input);
    return { shown: true };
  }

  async snapshot(): Promise<HerdrSnapshot> {
    return {
      version: "0.9.5",
      protocol: 22,
      workspaces: [...this.workspaces.values()].map(toWorkspace),
      panes: [...this.panes.values()].map(toPane),
      agents: [...this.agents.values()].map((a) => this.toAgent(a)),
    };
  }

  subscribe(input: SubscribeInput, onEvent: (event: HerdrEvent) => void): HerdrSubscription {
    const sub: FakeSubscription = { input, onEvent, closed: false };
    const missing = input.paneIds?.find((paneId) => !this.panes.has(paneId));
    if (missing) {
      // herdr rechaza la suscripción completa si un pane no existe.
      this.deliver(sub, {
        type: "subscription_failed",
        code: "pane_not_found",
        message: `pane ${missing} not found`,
      });
      return { close: async () => {} };
    }
    this.subscriptions.add(sub);
    this.deliver(sub, { type: "subscribed" });
    return {
      close: async () => {
        sub.closed = true;
        this.subscriptions.delete(sub);
      },
    };
  }

  // --- Controles de test: provocar lo que en herdr real hace el agente o el servidor. ---

  /** Cambia el estado de un agente y emite `agent_status_changed`, como su integración en herdr. */
  setAgentStatus(name: string, status: AgentStatus) {
    const agent = this.requireAgent(name);
    if (agent.status === status) return;
    agent.status = status;
    const pane = this.panes.get(agent.paneId);
    if (pane) {
      this.emit({
        type: "agent_status_changed",
        paneId: pane.paneId,
        workspaceId: pane.workspaceId,
        status,
      });
    }
    for (const check of [...this.statusWaiters]) check();
  }

  /** Publica la identidad de sesión del agente, como la integración oficial (`agent_session`). */
  setAgentSession(name: string, session: AgentSessionInfo) {
    this.requireAgent(name).session = session;
  }

  /** Simula que el proceso del agente terminó: el pane queda abierto sin agente. */
  exitAgent(name: string) {
    const agent = this.requireAgent(name);
    this.agents.delete(name);
    const pane = this.panes.get(agent.paneId);
    if (pane)
      this.emit({ type: "pane_exited", paneId: pane.paneId, workspaceId: pane.workspaceId });
    for (const check of [...this.statusWaiters]) check();
  }

  /** Args con que arrancó el agente (los que van después de `--`). */
  agentArgs(name: string): string[] {
    return [...this.requireAgent(name).args];
  }

  /** Env con que se creó el pane (`pane split --env`). */
  paneEnv(paneId: string): Record<string, string> {
    return { ...this.requirePane(paneId).env };
  }

  /** Cada llamada a `sendKeys` que recibió el agente. */
  sentKeys(name: string): string[][] {
    return this.requireAgent(name).keys.map((k) => [...k]);
  }

  /** Simula cambios sin commit en el checkout `path`. */
  setWorktreeDirty(path: string, dirty = true) {
    for (const repo of this.worktrees.values()) {
      for (const wt of repo.values()) if (wt.path === path) wt.dirty = dirty;
    }
  }

  /** Corta todos los streams como herdr bajo backpressure: cada uno pierde eventos y reconecta. */
  dropStreams() {
    for (const sub of this.subscriptions) {
      this.deliver(sub, { type: "events_lost", reason: "stream closed" });
      this.deliver(sub, { type: "subscribed" });
    }
  }

  // --- Internos ---

  private createWorkspace(
    label: string,
    repoPath: string,
    linkedWorktree: boolean,
    env: Record<string, string>,
  ) {
    const n = this.nextWorkspace++;
    const ws: FakeWorkspace = {
      workspaceId: `w${n}`,
      label,
      ...(linkedWorktree && { checkoutPath: repoPath }),
      repoPath,
      linkedWorktree,
      tabId: `w${n}:t1`,
      nextPane: 1,
    };
    this.workspaces.set(ws.workspaceId, ws);
    this.addPane(ws, repoPath, env);
    return ws;
  }

  private addPane(ws: FakeWorkspace, cwd: string, env: Record<string, string>) {
    const pane: FakePane = {
      paneId: `${ws.workspaceId}:p${ws.nextPane++}`,
      workspaceId: ws.workspaceId,
      tabId: ws.tabId,
      cwd,
      env,
      tokens: {},
      processes: [],
    };
    this.panes.set(pane.paneId, pane);
    return pane;
  }

  private removePane(paneId: string) {
    const pane = this.panes.get(paneId);
    if (!pane) return;
    this.panes.delete(paneId);
    for (const child of pane.processes) killGroup(child);
    for (const [name, agent] of this.agents) if (agent.paneId === paneId) this.agents.delete(name);
    this.emit({ type: "pane_closed", paneId, workspaceId: pane.workspaceId });
    for (const check of [...this.statusWaiters]) check();
    // Como herdr: al cerrarse el último pane se cierra su workspace.
    const empty = ![...this.panes.values()].some((p) => p.workspaceId === pane.workspaceId);
    if (empty) this.removeWorkspace(pane.workspaceId);
  }

  private rootPane(ws: FakeWorkspace) {
    const pane = [...this.panes.values()].find((p) => p.workspaceId === ws.workspaceId);
    if (!pane) throw new HerdrError("pane_not_found", `workspace ${ws.workspaceId} has no panes`);
    return pane.paneId;
  }

  private requirePane(paneId: string) {
    const pane = this.panes.get(paneId);
    if (!pane) throw new HerdrError("pane_not_found", `pane ${paneId} not found`);
    return pane;
  }

  private requireAgent(name: string) {
    const agent = this.agents.get(name);
    if (!agent) throw new HerdrError("agent_not_found", `agent target ${name} not found`);
    return agent;
  }

  private toWorktree(ws: FakeWorkspace, branch: string, path: string): HerdrWorktree {
    return { workspaceId: ws.workspaceId, branch, path, rootPaneId: this.rootPane(ws) };
  }

  private toAgent(agent: FakeAgent): HerdrAgent {
    const pane = this.panes.get(agent.paneId);
    return {
      name: agent.name,
      kind: agent.kind,
      paneId: agent.paneId,
      workspaceId: pane?.workspaceId ?? "",
      status: agent.status,
      ...(pane?.title !== undefined && { title: pane.title }),
      tokens: { ...pane?.tokens },
      ...(agent.session && { session: { ...agent.session } }),
    };
  }

  private emit(event: HerdrEvent) {
    for (const sub of this.subscriptions) {
      if (matches(sub.input, event)) this.deliver(sub, event);
    }
  }

  /** Entrega asíncrona, como el socket: nunca dentro de la llamada que provocó el evento. */
  private deliver(sub: FakeSubscription, event: HerdrEvent) {
    queueMicrotask(() => {
      if (!sub.closed) sub.onEvent(event);
    });
  }
}

function matches(input: SubscribeInput, event: HerdrEvent) {
  if (event.type === "agent_status_changed") return input.paneIds?.includes(event.paneId) ?? false;
  return input.lifecycle === true;
}

function toWorkspace(ws: FakeWorkspace): HerdrWorkspace {
  return {
    workspaceId: ws.workspaceId,
    label: ws.label,
    ...(ws.checkoutPath !== undefined && { checkoutPath: ws.checkoutPath }),
    linkedWorktree: ws.linkedWorktree,
  };
}

function toPane(pane: FakePane): HerdrPane {
  return { paneId: pane.paneId, workspaceId: pane.workspaceId, tabId: pane.tabId, cwd: pane.cwd };
}

function killGroup(child: ChildProcess) {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // El grupo ya terminó.
  }
}
