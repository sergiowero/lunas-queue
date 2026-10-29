// Interfaz del adapter de herdr (UW-02). El resto del sistema depende solo de esto;
// la implementación real (CLI + socket) y el fake en memoria cumplen la misma suite de contrato.
// Comportamiento de herdr 0.9.5 (protocol 22) en docs/decisions/0004-herdr-version-y-cli.md.

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface HerdrWorkspace {
  workspaceId: string;
  label: string;
  /**
   * Checkout del repo que abre el workspace, si herdr lo reporta: siempre en worktrees, no en
   * workspaces creados con `workspace create` (ADR 0004, adenda). No sirve para buscar proyectos.
   */
  checkoutPath?: string;
  /** true si el workspace abre un worktree enlazado (tarea), false si es el checkout principal. */
  linkedWorktree: boolean;
}

export interface HerdrWorktree {
  /** Workspace en el que herdr tiene abierto el worktree. */
  workspaceId: string;
  branch: string;
  path: string;
  rootPaneId: string;
}

/** Un worktree enlazado del repo, según `worktree list`; puede no estar abierto en herdr. */
export interface HerdrWorktreeEntry {
  /** Ausente si el checkout está en HEAD detached. */
  branch?: string;
  path: string;
  /** Workspace en el que está abierto, si lo está. */
  workspaceId?: string;
}

export interface HerdrPane {
  paneId: string;
  workspaceId: string;
  tabId: string;
  cwd: string;
}

export type AgentSessionInfo = { kind: string; source: string; value: string };

export interface HerdrAgent {
  name: string;
  kind: string;
  paneId: string;
  workspaceId: string;
  status: AgentStatus;
  title?: string;
  tokens: Record<string, string>;
  /** Identidad de sesión que reporta la integración del agente (`agent_session`). */
  session?: AgentSessionInfo;
}

export interface HerdrSnapshot {
  version: string;
  protocol: number;
  workspaces: HerdrWorkspace[];
  panes: HerdrPane[];
  agents: HerdrAgent[];
}

export type HerdrEvent =
  /** Una suscripción quedó activa (al abrirla y tras cada reconexión). */
  | { type: "subscribed" }
  /**
   * El stream se cerró sin que el consumidor lo pidiera. herdr 0.9.5 no manda `events_lost`
   * (ADR 0004): todo cierre cuenta como pérdida y quien consume debe reconciliar con `snapshot`.
   */
  | { type: "events_lost"; reason: string }
  /** herdr rechazó la suscripción (p. ej. el pane ya no existe). Es terminal: no se reintenta. */
  | { type: "subscription_failed"; code: string; message: string }
  | { type: "agent_status_changed"; paneId: string; workspaceId: string; status: AgentStatus }
  | { type: "pane_closed"; paneId: string; workspaceId: string }
  | { type: "pane_exited"; paneId: string; workspaceId: string }
  | { type: "workspace_closed"; workspaceId: string }
  | { type: "worktree_created"; workspaceId: string }
  | { type: "worktree_removed"; workspaceId: string };

export interface HerdrSubscription {
  /** Cierra la suscripción a propósito: no emite `events_lost` ni reconecta. */
  close(): Promise<void>;
}

export interface SubscribeInput {
  /**
   * Panes cuyo `pane.agent_status_changed` se escucha (herdr exige suscripción por pane). Si uno
   * no existe, herdr rechaza la suscripción completa (`subscription_failed`), también al
   * re‑suscribir tras una pérdida: conviene una suscripción por pane.
   */
  paneIds?: string[];
  /** Eventos globales de ciclo de vida: panes cerrados o terminados, workspaces y worktrees. */
  lifecycle?: boolean;
}

export interface HerdrAdapter {
  /**
   * Usa `workspaceId` si sigue vivo; si no, el workspace principal (no worktree) con ese `label`;
   * si no, lo crea en `cwd`. Se busca por label porque herdr no reporta el checkout de un
   * workspace creado con `workspace create`; LunasQ controla los labels de sus proyectos.
   */
  ensureWorkspace(input: {
    cwd: string;
    label: string;
    workspaceId?: string;
    env?: Record<string, string>;
  }): Promise<{ workspace: HerdrWorkspace; rootPaneId: string; created: boolean }>;
  /** Idempotente: cerrar un workspace que ya no existe no falla. */
  closeWorkspace(workspaceId: string): Promise<void>;

  /** `worktree list` → `open` si el branch ya tiene worktree, `create` si no (ADR 0004). */
  ensureWorktree(input: {
    workspaceId: string;
    branch: string;
    base: string;
    path?: string;
    label?: string;
  }): Promise<{ worktree: HerdrWorktree; created: boolean }>;
  /**
   * Worktrees enlazados del repo del workspace `workspaceId`; el checkout principal no se
   * incluye. Un worktree removido ya no aparece aunque su branch siga.
   */
  listWorktrees(workspaceId: string): Promise<HerdrWorktreeEntry[]>;
  /**
   * Borra el checkout y cierra su workspace; conserva el branch. Idempotente: si el workspace ya
   * no existe no falla. Sobre un workspace que no es worktree lanza `not_linked_worktree`; con
   * cambios sin commit y sin `force`, `dirty_worktree_requires_force` (ADR 0012).
   */
  removeWorktree(input: { workspaceId: string; force?: boolean }): Promise<void>;

  /** El env del Run se fija aquí: `agent start` no lo acepta (ADR 0004). */
  splitPane(input: {
    paneId: string;
    direction?: "right" | "down";
    cwd?: string;
    env?: Record<string, string>;
  }): Promise<HerdrPane>;
  /** Idempotente: cerrar un pane que ya no existe no falla. Cerrar el último pane cierra su workspace. */
  closePane(paneId: string): Promise<void>;
  /**
   * Escribe `command` en el shell del pane y lo ejecuta (`pane run`); no espera a que termine ni
   * informa su exit code. Corre con el cwd y el env del pane; cerrar el pane lo mata.
   * `pane_not_found` si el pane no existe.
   */
  runInPane(input: { paneId: string; command: string }): Promise<void>;

  /**
   * Idempotente por nombre: si ya hay un agente con ese nombre lo devuelve con `started: false`.
   * Si el agente arranca bloqueado (p. ej. diálogo de confianza) devuelve su estado `blocked`.
   */
  startAgent(input: {
    name: string;
    kind: string;
    paneId: string;
    args?: string[];
    timeoutMs?: number;
  }): Promise<{ agent: HerdrAgent; started: boolean }>;
  getAgent(name: string): Promise<HerdrAgent | undefined>;
  /**
   * Con `wait`, herdr lanza `agent_prompt_stalled` si no ve `working`/`blocked` en 5 s y
   * `timeout` si no llega a `until` a tiempo.
   */
  promptAgent(input: {
    name: string;
    text: string;
    wait?: { timeoutMs: number; until?: AgentStatus[] };
  }): Promise<HerdrAgent>;
  /**
   * Lanza `HerdrError` con code `timeout` si no llega a ninguno de los estados. Sin `timeoutMs`
   * espera indefinidamente.
   */
  waitAgent(input: {
    name: string;
    until?: AgentStatus[];
    timeoutMs?: number;
  }): Promise<HerdrAgent>;
  readAgent(input: { name: string; lines?: number }): Promise<string>;
  /**
   * Teclas a la TUI del agente (`agent send-keys`), con los nombres de herdr: `enter`, `down`,
   * `esc`… Sirve para aceptar el diálogo de confianza de carpeta (ADR 0004).
   */
  sendKeys(input: { name: string; keys: string[] }): Promise<void>;

  /** Título y tokens del sidebar (task id, fase, iteración). */
  reportMetadata(input: {
    paneId: string;
    title?: string;
    tokens?: Record<string, string>;
  }): Promise<void>;
  notify(input: {
    title: string;
    body?: string;
    sound?: "none" | "done" | "request";
  }): Promise<{ shown: boolean; reason?: string }>;
  snapshot(): Promise<HerdrSnapshot>;
  /**
   * Abre un stream de eventos. Si se cierra sin `close()`, emite `events_lost`, reconecta,
   * vuelve a suscribirse y emite `subscribed`.
   */
  subscribe(input: SubscribeInput, onEvent: (event: HerdrEvent) => void): HerdrSubscription;
}
