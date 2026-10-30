// Esquemas Zod de las respuestas y eventos de herdr (protocol 22) que el adapter usa.
// Objetos laxos: solo se validan los campos que se leen, para tolerar campos nuevos de herdr.
// Referencia: spikes/herdr/outputs/api-schema.json y las salidas reales del spike (ADR 0004).
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { z } from "zod";
import type {
  HerdrAgent,
  HerdrEvent,
  HerdrPane,
  HerdrSnapshot,
  HerdrWorkspace,
  HerdrWorktree,
  HerdrWorktreeEntry,
} from "./types.ts";

const agentStatus = z.enum(["idle", "working", "blocked", "done", "unknown"]);

export const workspaceWire = z.looseObject({
  workspace_id: z.string(),
  label: z.string(),
  worktree: z.looseObject({ checkout_path: z.string(), is_linked_worktree: z.boolean() }).nullish(),
});

export const paneWire = z.looseObject({
  pane_id: z.string(),
  workspace_id: z.string(),
  tab_id: z.string(),
  cwd: z.string(),
});

export const agentWire = z.looseObject({
  name: z.string(),
  agent: z.string(),
  pane_id: z.string(),
  workspace_id: z.string(),
  agent_status: agentStatus,
  title: z.string().nullish(),
  tokens: z.record(z.string(), z.string().nullable()).nullish(),
  agent_session: z
    .looseObject({ kind: z.string(), source: z.string(), value: z.string() })
    .nullish(),
});

export const worktreeWire = z.looseObject({
  branch: z.string().nullish(),
  path: z.string(),
  open_workspace_id: z.string().nullish(),
  is_linked_worktree: z.boolean().nullish(),
});

export const workspaceCreatedWire = z.looseObject({
  workspace: workspaceWire,
  root_pane: paneWire,
});

export const worktreeOpenedWire = z.looseObject({
  workspace: workspaceWire,
  root_pane: paneWire,
  worktree: worktreeWire,
});

export const worktreeListWire = z.looseObject({ worktrees: z.array(worktreeWire) });
export const paneInfoWire = z.looseObject({ pane: paneWire });
export const agentInfoWire = z.looseObject({ agent: agentWire });
export const notificationWire = z.looseObject({
  shown: z.boolean(),
  reason: z.string().nullish(),
});

// herdr detecta agentes que el usuario abrió a mano y no tienen `name`, o panes recién creados
// que aún no identifican `agent`: LunasQ no puede direccionarlos, así que el snapshot los tolera
// y `toSnapshot` los descarta.
const snapshotAgentWire = agentWire.extend({
  name: z.string().nullish(),
  agent: z.string().nullish(),
});

export const snapshotWire = z.looseObject({
  snapshot: z.looseObject({
    version: z.string(),
    protocol: z.number(),
    workspaces: z.array(workspaceWire),
    panes: z.array(paneWire),
    agents: z.array(snapshotAgentWire),
  }),
});

// Líneas del stream de `events.subscribe`: respuesta inicial, error o evento.
export const subscriptionStartedWire = z.looseObject({
  result: z.looseObject({ type: z.literal("subscription_started") }),
});
export const streamErrorWire = z.looseObject({
  error: z.looseObject({ code: z.string(), message: z.string() }),
});
export const streamEventWire = z.looseObject({ event: z.string(), data: z.unknown() });

/**
 * Ruta canónica para comparar con lo que reporta herdr: expande el `~` con que colapsa el home y
 * resuelve symlinks (herdr devuelve a veces la ruta pedida y a veces la real, p. ej. `/private/var`).
 */
export function normalizePath(path: string): string {
  const expanded =
    path === "~" ? homedir() : path.startsWith("~/") ? `${homedir()}${path.slice(1)}` : path;
  try {
    return realpathSync(expanded);
  } catch {
    return expanded;
  }
}

export function toWorkspace(w: z.infer<typeof workspaceWire>): HerdrWorkspace {
  return {
    workspaceId: w.workspace_id,
    label: w.label,
    ...(w.worktree && { checkoutPath: normalizePath(w.worktree.checkout_path) }),
    linkedWorktree: w.worktree?.is_linked_worktree ?? false,
  };
}

export function toPane(p: z.infer<typeof paneWire>): HerdrPane {
  return {
    paneId: p.pane_id,
    workspaceId: p.workspace_id,
    tabId: p.tab_id,
    cwd: normalizePath(p.cwd),
  };
}

export function toAgent(a: z.infer<typeof agentWire>): HerdrAgent {
  const tokens: Record<string, string> = {};
  for (const [k, v] of Object.entries(a.tokens ?? {})) if (v !== null) tokens[k] = v;
  return {
    name: a.name,
    kind: a.agent,
    paneId: a.pane_id,
    workspaceId: a.workspace_id,
    status: a.agent_status,
    ...(a.title != null && { title: a.title }),
    tokens,
    ...(a.agent_session && {
      session: {
        kind: a.agent_session.kind,
        source: a.agent_session.source,
        value: a.agent_session.value,
      },
    }),
  };
}

export function toWorktree(r: z.infer<typeof worktreeOpenedWire>, branch: string): HerdrWorktree {
  return {
    workspaceId: r.workspace.workspace_id,
    branch: r.worktree.branch ?? branch,
    path: normalizePath(r.worktree.path),
    rootPaneId: r.root_pane.pane_id,
  };
}

export function toWorktreeEntry(w: z.infer<typeof worktreeWire>): HerdrWorktreeEntry {
  return {
    ...(w.branch && { branch: w.branch }),
    path: normalizePath(w.path),
    ...(w.open_workspace_id && { workspaceId: w.open_workspace_id }),
  };
}

export function toSnapshot(r: z.infer<typeof snapshotWire>): HerdrSnapshot {
  const s = r.snapshot;
  return {
    version: s.version,
    protocol: s.protocol,
    workspaces: s.workspaces.map(toWorkspace),
    panes: s.panes.map(toPane),
    agents: s.agents.flatMap((a) =>
      a.name && a.agent ? [toAgent({ ...a, name: a.name, agent: a.agent })] : [],
    ),
  };
}

const paneEventData = z.looseObject({ pane_id: z.string(), workspace_id: z.string() });
const workspaceEventData = z.looseObject({
  workspace_id: z.string().optional(),
  workspace: z.looseObject({ workspace_id: z.string().optional() }).optional(),
});

/** Traduce un evento de herdr; devuelve undefined para los que el adapter no expone. */
export function toEvent(event: string, data: unknown): HerdrEvent | undefined {
  switch (event) {
    case "pane.agent_status_changed":
    case "pane_agent_status_changed": {
      const d = paneEventData.extend({ agent_status: agentStatus }).parse(data);
      return {
        type: "agent_status_changed",
        paneId: d.pane_id,
        workspaceId: d.workspace_id,
        status: d.agent_status,
      };
    }
    case "pane_closed":
    case "pane_exited": {
      const d = paneEventData.parse(data);
      return { type: event, paneId: d.pane_id, workspaceId: d.workspace_id };
    }
    case "workspace_closed":
    case "worktree_created":
    case "worktree_removed": {
      const d = workspaceEventData.parse(data);
      const workspaceId = d.workspace_id ?? d.workspace?.workspace_id;
      return workspaceId ? { type: event, workspaceId } : undefined;
    }
    default:
      return undefined;
  }
}
