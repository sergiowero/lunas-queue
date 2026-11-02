// herdr adapter interface. The rest of the system depends only on this;
// the real implementation (CLI + socket) and the in-memory fake pass the same contract suite.
// herdr 0.9.5 (protocol 22) behavior in docs/decisions/0004-herdr-version-y-cli.md.

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface HerdrWorkspace {
  workspaceId: string;
  label: string;
  /**
   * Checkout of the repo that opens the workspace, if herdr reports it: always on worktrees, not on
   * workspaces created with `workspace create` (ADR 0004, addendum). Not usable to look up projects.
   */
  checkoutPath?: string;
  /** true if the workspace opens a linked worktree (task), false if it is the main checkout. */
  linkedWorktree: boolean;
}

export interface HerdrWorktree {
  /** Workspace in which herdr has the worktree open. */
  workspaceId: string;
  branch: string;
  path: string;
  rootPaneId: string;
}

/** A linked worktree of the repo, per `worktree list`; it may not be open in herdr. */
export interface HerdrWorktreeEntry {
  /** Absent if the checkout is at a detached HEAD. */
  branch?: string;
  path: string;
  /** Workspace in which it is open, if it is. */
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
  /** Session identity reported by the agent's integration (`agent_session`). */
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
  /** A subscription became active (on opening it and after each reconnection). */
  | { type: "subscribed" }
  /**
   * The stream closed without the consumer asking for it. herdr 0.9.5 does not send `events_lost`
   * (ADR 0004): every close counts as a loss and the consumer must reconcile with `snapshot`.
   */
  | { type: "events_lost"; reason: string }
  /** herdr rejected the subscription (e.g. the pane no longer exists). It is terminal: no retry. */
  | { type: "subscription_failed"; code: string; message: string }
  | { type: "agent_status_changed"; paneId: string; workspaceId: string; status: AgentStatus }
  | { type: "pane_closed"; paneId: string; workspaceId: string }
  | { type: "pane_exited"; paneId: string; workspaceId: string }
  | { type: "workspace_closed"; workspaceId: string }
  | { type: "worktree_created"; workspaceId: string }
  | { type: "worktree_removed"; workspaceId: string };

export interface HerdrSubscription {
  /** Closes the subscription on purpose: it neither emits `events_lost` nor reconnects. */
  close(): Promise<void>;
}

export interface SubscribeInput {
  /**
   * Panes whose `pane.agent_status_changed` is listened to (herdr requires a per-pane subscription). If one
   * does not exist, herdr rejects the whole subscription (`subscription_failed`), also when
   * re-subscribing after a loss: one subscription per pane is advisable.
   */
  paneIds?: string[];
  /** Global lifecycle events: panes closed or finished, workspaces and worktrees. */
  lifecycle?: boolean;
}

export interface HerdrAdapter {
  /**
   * Uses `workspaceId` if it is still alive; otherwise the main workspace (not a worktree) with that `label`;
   * otherwise it creates it in `cwd`. It is looked up by label because herdr does not report the checkout of a
   * workspace created with `workspace create`; LunasQ controls its projects' labels.
   */
  ensureWorkspace(input: {
    cwd: string;
    label: string;
    workspaceId?: string;
    env?: Record<string, string>;
  }): Promise<{ workspace: HerdrWorkspace; rootPaneId: string; created: boolean }>;
  /** Idempotent: closing a workspace that no longer exists does not fail. */
  closeWorkspace(workspaceId: string): Promise<void>;

  /** `worktree list` → `open` if the branch already has a worktree, `create` if not (ADR 0004). */
  ensureWorktree(input: {
    workspaceId: string;
    branch: string;
    base: string;
    path?: string;
    label?: string;
  }): Promise<{ worktree: HerdrWorktree; created: boolean }>;
  /**
   * Linked worktrees of the repo of workspace `workspaceId`; the main checkout is not
   * included. A removed worktree no longer appears even if its branch remains.
   */
  listWorktrees(workspaceId: string): Promise<HerdrWorktreeEntry[]>;
  /**
   * Deletes the checkout and closes its workspace; keeps the branch. Idempotent: if the workspace no
   * longer exists it does not fail. On a workspace that is not a worktree it throws `not_linked_worktree`; with
   * uncommitted changes and without `force`, `dirty_worktree_requires_force` (ADR 0012).
   */
  removeWorktree(input: { workspaceId: string; force?: boolean }): Promise<void>;

  /** The Run's env is set here: `agent start` does not accept it (ADR 0004). */
  splitPane(input: {
    paneId: string;
    direction?: "right" | "down";
    cwd?: string;
    env?: Record<string, string>;
  }): Promise<HerdrPane>;
  /** Idempotent: closing a pane that no longer exists does not fail. Closing the last pane closes its workspace. */
  closePane(paneId: string): Promise<void>;
  /**
   * Writes `command` into the pane's shell and runs it (`pane run`); it does not wait for it to finish nor
   * report its exit code. It runs with the pane's cwd and env; closing the pane kills it.
   * `pane_not_found` if the pane does not exist.
   */
  runInPane(input: { paneId: string; command: string }): Promise<void>;

  /**
   * Idempotent by name: if an agent with that name already exists it returns it with `started: false`.
   * If the agent starts blocked (e.g. trust dialog) it returns its `blocked` state.
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
   * With `wait`, herdr throws `agent_prompt_stalled` if it does not see `working`/`blocked` in 5 s and
   * `timeout` if it does not reach `until` in time.
   */
  promptAgent(input: {
    name: string;
    text: string;
    wait?: { timeoutMs: number; until?: AgentStatus[] };
  }): Promise<HerdrAgent>;
  /**
   * Throws `HerdrError` with code `timeout` if it reaches none of the states. Without `timeoutMs`
   * espera indefinidamente.
   */
  waitAgent(input: {
    name: string;
    until?: AgentStatus[];
    timeoutMs?: number;
  }): Promise<HerdrAgent>;
  readAgent(input: { name: string; lines?: number }): Promise<string>;
  /**
   * Keys to the agent's TUI (`agent send-keys`), with herdr's names: `enter`, `down`,
   * `esc`… Useful to accept the folder trust dialog (ADR 0004).
   */
  sendKeys(input: { name: string; keys: string[] }): Promise<void>;
  /**
   * Brings the human's view to the agent's pane (`agent focus`): this is how a permission in the
   * TUI is answered. `agent_not_found` if the agent does not exist.
   */
  focusAgent(name: string): Promise<HerdrAgent>;

  /** Title and tokens of the sidebar (task id, phase, iteration). */
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
   * Opens an event stream. If it closes without `close()`, it emits `events_lost`, reconnects,
   * re-subscribes and emits `subscribed`.
   */
  subscribe(input: SubscribeInput, onEvent: (event: HerdrEvent) => void): HerdrSubscription;
}
