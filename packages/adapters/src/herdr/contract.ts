// Contract suite of the herdr adapter: the same one runs against the fake (pnpm test) and against
// real herdr (pnpm --filter @lunasq/adapters test:herdr). Done criterion of UW-02.
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HerdrPaneRunner } from "../process/pane.ts";
import { isHerdrError } from "./errors.ts";
import type { AgentStatus, HerdrAdapter, HerdrEvent, HerdrSubscription } from "./types.ts";

export interface HerdrContractHarness {
  adapter: HerdrAdapter;
  /** A new git repo with a commit on `main`, to open the project's workspace. */
  newRepo(): Promise<string>;
  /** Path where to create the worktree `name` (outside `~/.herdr/worktrees`). */
  worktreePath(name: string): string;
  /** Kind and env of the pane so `agent start` brings up an agent that answers prompts. */
  agentKind: string;
  agentEnv: Record<string, string>;
  /** Cuts the open event streams, like when herdr closes one due to backpressure. */
  dropStreams(): void;
  cleanup(): Promise<void>;
}

const SETTLED: AgentStatus[] = ["idle", "done"];

async function until(check: () => boolean, what: string, timeoutMs = 4_000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timeout esperando ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export function herdrContract(
  name: string,
  setup: () => Promise<HerdrContractHarness>,
  opts: { timeoutMs?: number } = {},
): void {
  const timeout = opts.timeoutMs ?? 5_000;

  describe(`herdr adapter contract: ${name}`, { timeout }, () => {
    let h: HerdrContractHarness;
    let herdr: HerdrAdapter;
    let seq = 0;
    const unique = (prefix: string) => `${prefix}${Date.now().toString(36)}${++seq}`;

    beforeAll(async () => {
      h = await setup();
      herdr = h.adapter;
    }, 30_000);

    const tempDirs: string[] = [];
    /** Real directory for `runInPane` commands (the fake's repos do not exist on disk). */
    const tempDir = () => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), "lunasq-pane-")));
      tempDirs.push(dir);
      return dir;
    };

    afterAll(async () => {
      for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
      await h?.cleanup();
    }, 30_000);

    async function projectWorkspace() {
      const cwd = await h.newRepo();
      return herdr.ensureWorkspace({ cwd, label: unique("proj-") });
    }

    async function agentInNewPane() {
      const { rootPaneId } = await projectWorkspace();
      const pane = await herdr.splitPane({ paneId: rootPaneId, env: h.agentEnv });
      const name = unique("t");
      const { agent } = await herdr.startAgent({ name, kind: h.agentKind, paneId: pane.paneId });
      return { pane, name, agent };
    }

    function collect(subscribe: (onEvent: (e: HerdrEvent) => void) => HerdrSubscription) {
      const events: HerdrEvent[] = [];
      const waiters: { pred: (e: HerdrEvent) => boolean; resolve: (e: HerdrEvent) => void }[] = [];
      const sub = subscribe((e) => {
        events.push(e);
        for (const w of [...waiters]) {
          if (w.pred(e)) {
            waiters.splice(waiters.indexOf(w), 1);
            w.resolve(e);
          }
        }
      });
      // Waits for an event that meets `pred` after index `from` (by default, any).
      const next = (pred: (e: HerdrEvent) => boolean, from = 0) => {
        const seen = events.slice(from).find(pred);
        if (seen) return Promise.resolve(seen);
        return new Promise<HerdrEvent>((resolve, reject) => {
          const w = { pred, resolve };
          waiters.push(w);
          setTimeout(() => {
            if (!waiters.includes(w)) return;
            waiters.splice(waiters.indexOf(w), 1);
            reject(new Error(`event not received; received: ${JSON.stringify(events)}`));
          }, timeout - 500);
        });
      };
      return { sub, events, next };
    }

    describe("workspaces", () => {
      it("ensureWorkspace creates once and then reuses the same one", async () => {
        const cwd = await h.newRepo();
        const label = unique("proj-");
        const first = await herdr.ensureWorkspace({ cwd, label });
        expect(first.created).toBe(true);
        expect(first.workspace.label).toBe(label);
        expect(first.rootPaneId).toBeTruthy();

        const byLabel = await herdr.ensureWorkspace({ cwd, label });
        expect(byLabel.created).toBe(false);
        expect(byLabel.workspace.workspaceId).toBe(first.workspace.workspaceId);
        expect(byLabel.rootPaneId).toBe(first.rootPaneId);

        const byId = await herdr.ensureWorkspace({
          cwd,
          label: unique("renombrado-"),
          workspaceId: first.workspace.workspaceId,
        });
        expect(byId.created).toBe(false);
        expect(byId.workspace.workspaceId).toBe(first.workspace.workspaceId);

        const snap = await herdr.snapshot();
        const ids = snap.workspaces.map((w) => w.workspaceId);
        expect(ids.filter((id) => id === first.workspace.workspaceId)).toHaveLength(1);
      });

      it("closeWorkspace is idempotent and a later ensure creates again", async () => {
        const cwd = await h.newRepo();
        const label = unique("proj-");
        const { workspace } = await herdr.ensureWorkspace({ cwd, label });
        await herdr.closeWorkspace(workspace.workspaceId);
        await herdr.closeWorkspace(workspace.workspaceId);

        const snap = await herdr.snapshot();
        expect(snap.workspaces.map((w) => w.workspaceId)).not.toContain(workspace.workspaceId);

        const again = await herdr.ensureWorkspace({
          cwd,
          label,
          workspaceId: workspace.workspaceId,
        });
        expect(again.created).toBe(true);
      });
    });

    describe("worktrees", () => {
      it("ensureWorktree creates the first time and reopens the same one afterwards", async () => {
        const { workspace } = await projectWorkspace();
        const branch = `lunasq/${unique("t")}`;
        const path = h.worktreePath(branch.replace("/", "-"));

        const first = await herdr.ensureWorktree({
          workspaceId: workspace.workspaceId,
          branch,
          base: "main",
          path,
          label: "t1",
        });
        expect(first.created).toBe(true);
        expect(first.worktree.branch).toBe(branch);
        expect(first.worktree.path).toBe(path);
        expect(first.worktree.workspaceId).not.toBe(workspace.workspaceId);

        const second = await herdr.ensureWorktree({
          workspaceId: workspace.workspaceId,
          branch,
          base: "main",
          path,
        });
        expect(second.created).toBe(false);
        expect(second.worktree).toEqual(first.worktree);

        const snap = await herdr.snapshot();
        const ws = snap.workspaces.find((w) => w.workspaceId === first.worktree.workspaceId);
        expect(ws?.linkedWorktree).toBe(true);
      });

      it("removeWorktree closes its workspace and keeps the branch", async () => {
        const { workspace } = await projectWorkspace();
        const branch = `lunasq/${unique("t")}`;
        const path = h.worktreePath(branch.replace("/", "-"));
        const input = { workspaceId: workspace.workspaceId, branch, base: "main", path };
        const { worktree } = await herdr.ensureWorktree(input);

        await herdr.removeWorktree({ workspaceId: worktree.workspaceId });

        const snap = await herdr.snapshot();
        expect(snap.workspaces.map((w) => w.workspaceId)).not.toContain(worktree.workspaceId);
        expect(snap.workspaces.map((w) => w.workspaceId)).toContain(workspace.workspaceId);

        // The branch remains: ensuring the worktree again takes it from that same branch.
        const again = await herdr.ensureWorktree(input);
        expect(again.created).toBe(true);
        expect(again.worktree.branch).toBe(branch);
      });

      it("removeWorktree is idempotent and rejects the project's workspace", async () => {
        const { workspace } = await projectWorkspace();
        const branch = `lunasq/${unique("t")}`;
        const path = h.worktreePath(branch.replace("/", "-"));
        const { worktree } = await herdr.ensureWorktree({
          workspaceId: workspace.workspaceId,
          branch,
          base: "main",
          path,
        });

        await herdr.removeWorktree({ workspaceId: worktree.workspaceId });
        await herdr.removeWorktree({ workspaceId: worktree.workspaceId });
        await expect(
          herdr.removeWorktree({ workspaceId: workspace.workspaceId }),
        ).rejects.toSatisfy((err) => isHerdrError(err, "not_linked_worktree"));
      });

      it("listWorktrees gives the linked worktrees, open or not, and forgets the removed ones", async () => {
        const { workspace } = await projectWorkspace();
        const projectId = workspace.workspaceId;
        expect(await herdr.listWorktrees(projectId)).toEqual([]);

        const worktree = async (name: string) => {
          const branch = `lunasq/${unique(name)}`;
          const path = h.worktreePath(branch.replace("/", "-"));
          const res = await herdr.ensureWorktree({
            workspaceId: projectId,
            branch,
            base: "main",
            path,
          });
          return res.worktree;
        };
        const a = await worktree("a");
        const b = await worktree("b");
        const byBranch = async () => {
          const list = await herdr.listWorktrees(projectId);
          return new Map(list.map((w) => [w.branch, w]));
        };

        const both = await byBranch();
        expect(both.size).toBe(2);
        expect(both.get(a.branch)).toEqual({
          branch: a.branch,
          path: a.path,
          workspaceId: a.workspaceId,
        });
        expect(both.get(b.branch)?.workspaceId).toBe(b.workspaceId);

        // Closing the workspace does not delete the checkout: it stays listed, without an open workspace.
        await herdr.closeWorkspace(a.workspaceId);
        expect((await byBranch()).get(a.branch)).toEqual({ branch: a.branch, path: a.path });

        await herdr.removeWorktree({ workspaceId: b.workspaceId });
        expect([...(await byBranch()).keys()]).toEqual([a.branch]);
      });

      it("listWorktrees fails with a nonexistent workspace", async () => {
        await expect(herdr.listWorktrees("w999999")).rejects.toSatisfy((err) =>
          isHerdrError(err, "workspace_not_found"),
        );
      });
    });

    describe("panes", () => {
      it("closing the last pane closes its workspace", async () => {
        const { workspace, rootPaneId } = await projectWorkspace();
        await herdr.closePane(rootPaneId);
        const snap = await herdr.snapshot();
        expect(snap.workspaces.map((w) => w.workspaceId)).not.toContain(workspace.workspaceId);
      });

      it("splitPane opens a pane in the workspace and closePane is idempotent", async () => {
        const { workspace, rootPaneId } = await projectWorkspace();
        const pane = await herdr.splitPane({ paneId: rootPaneId, env: { LUNASQ_RUN_TOKEN: "x" } });
        expect(pane.workspaceId).toBe(workspace.workspaceId);
        expect(pane.paneId).not.toBe(rootPaneId);

        let snap = await herdr.snapshot();
        expect(snap.panes.map((p) => p.paneId)).toContain(pane.paneId);

        await herdr.closePane(pane.paneId);
        await herdr.closePane(pane.paneId);
        snap = await herdr.snapshot();
        expect(snap.panes.map((p) => p.paneId)).not.toContain(pane.paneId);
      });

      it("runInPane runs the command with the pane's cwd and env, without waiting for it", async () => {
        const { rootPaneId } = await projectWorkspace();
        const cwd = tempDir();
        const pane = await herdr.splitPane({
          paneId: rootPaneId,
          cwd,
          env: { LUNASQ_PROBE: "x1" },
        });
        await herdr.runInPane({
          paneId: pane.paneId,
          command: 'printf %s "$LUNASQ_PROBE" > probe',
        });
        const out = join(cwd, "probe");
        await until(() => existsSync(out) && readFileSync(out, "utf8") === "x1", "the command");
        await herdr.closePane(pane.paneId);
      });

      it("closing the pane kills the command and runInPane on a nonexistent pane fails", async () => {
        const { rootPaneId } = await projectWorkspace();
        const cwd = tempDir();
        const pane = await herdr.splitPane({ paneId: rootPaneId, cwd });
        await herdr.runInPane({ paneId: pane.paneId, command: "sleep 1 && touch late" });
        await herdr.closePane(pane.paneId);
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        expect(existsSync(join(cwd, "late"))).toBe(false);

        await expect(herdr.runInPane({ paneId: pane.paneId, command: "true" })).rejects.toSatisfy(
          (err) => isHerdrError(err, "pane_not_found"),
        );
      });
    });

    describe("HerdrPaneRunner on top of the adapter", () => {
      it("gives the exit code and output of a command run in a new pane", async () => {
        const { rootPaneId } = await projectWorkspace();
        const cwd = tempDir();
        const runner = new HerdrPaneRunner({
          herdr,
          parentPaneId: rootPaneId,
          stateDir: tempDir(),
        });
        const res = await runner.run({
          command: `printf '%s\\n' "$LUNASQ_HOOK_POINT"; pwd; exit 4`,
          cwd,
          env: { LUNASQ_HOOK_POINT: "before_delivery" },
          timeoutMs: 3_000,
        });
        expect(res).toMatchObject({ exitCode: 4, timedOut: false });
        expect(res.stdout.replaceAll("\r", "")).toBe(`before_delivery\n${cwd}\n`);
        const snap = await herdr.snapshot();
        expect(snap.panes.filter((p) => p.paneId !== rootPaneId && p.cwd === cwd)).toEqual([]);
      });

      it("with envAllowlist the command only sees those variables and those of env", async () => {
        const { rootPaneId } = await projectWorkspace();
        const runner = new HerdrPaneRunner({
          herdr,
          parentPaneId: rootPaneId,
          stateDir: tempDir(),
        });
        const res = await runner.run({
          command: `printf '%s|%s|%s' "\${USER-}" "\${HOME:+home}" "$LUNASQ_TASK_ID"`,
          cwd: tempDir(),
          env: { LUNASQ_TASK_ID: "t-1" },
          envAllowlist: ["HOME", "PATH"],
          timeoutMs: 3_000,
        });
        expect(res).toMatchObject({ exitCode: 0, timedOut: false });
        expect(res.stdout.replaceAll("\r", "")).toBe("|home|t-1");
      });
    });

    describe("agentes", () => {
      it("startAgent is idempotent by name", async () => {
        const { pane, name, agent } = await agentInNewPane();
        expect(agent.name).toBe(name);
        expect(agent.paneId).toBe(pane.paneId);
        expect(agent.kind).toBe(h.agentKind);

        const again = await herdr.startAgent({ name, kind: h.agentKind, paneId: pane.paneId });
        expect(again.started).toBe(false);
        expect(again.agent.paneId).toBe(pane.paneId);

        const snap = await herdr.snapshot();
        expect(snap.agents.filter((a) => a.name === name)).toHaveLength(1);
      });

      it("getAgent returns undefined if the agent does not exist", async () => {
        expect(await herdr.getAgent(unique("nadie-"))).toBeUndefined();
      });

      it("promptAgent with wait waits for the agent to finish and readAgent sees the prompt", async () => {
        const { name } = await agentInNewPane();
        const text = `hola ${unique("p")}`;
        const after = await herdr.promptAgent({ name, text, wait: { timeoutMs: timeout - 1_000 } });
        expect(SETTLED).toContain(after.status);

        const settled = await herdr.waitAgent({ name, until: SETTLED, timeoutMs: 2_000 });
        expect(SETTLED).toContain(settled.status);
        expect(await herdr.readAgent({ name, lines: 20 })).toContain(text);
      });

      it("sendKeys reaches the agent and fails with agent_not_found if it does not exist", async () => {
        const { name } = await agentInNewPane();
        await herdr.sendKeys({ name, keys: ["enter"] });
        await expect(herdr.sendKeys({ name: unique("nadie-"), keys: ["enter"] })).rejects.toSatisfy(
          (err) => isHerdrError(err, "agent_not_found"),
        );
      });

      it("focusAgent focuses the agent's pane and fails with agent_not_found if it does not exist", async () => {
        const { pane, name } = await agentInNewPane();
        const focused = await herdr.focusAgent(name);
        expect(focused.name).toBe(name);
        expect(focused.paneId).toBe(pane.paneId);
        await expect(herdr.focusAgent(unique("nadie-"))).rejects.toSatisfy((err) =>
          isHerdrError(err, "agent_not_found"),
        );
      });

      it("waitAgent throws timeout if the agent does not reach the state", async () => {
        const { name } = await agentInNewPane();
        await expect(
          herdr.waitAgent({ name, until: ["working"], timeoutMs: 500 }),
        ).rejects.toSatisfy((err) => isHerdrError(err, "timeout"));
      });
    });

    describe("metadata, notifications and snapshot", () => {
      it("reportMetadata publishes title and tokens; the last report wins", async () => {
        const { pane, name } = await agentInNewPane();
        await herdr.reportMetadata({
          paneId: pane.paneId,
          title: "t1 · refine #1",
          tokens: { task: "t1", phase: "refine", iter: "1" },
        });
        await herdr.reportMetadata({
          paneId: pane.paneId,
          title: "t1 · refine #2",
          tokens: { task: "t1", phase: "refine", iter: "2" },
        });

        const agent = await herdr.getAgent(name);
        expect(agent?.title).toBe("t1 · refine #2");
        expect(agent?.tokens).toMatchObject({ task: "t1", phase: "refine", iter: "2" });

        const snap = await herdr.snapshot();
        expect(snap.agents.find((a) => a.name === name)?.tokens).toMatchObject({ iter: "2" });
      });

      it("notify answers whether herdr showed the notification", async () => {
        const res = await herdr.notify({ title: "LunasQ", body: "contrato", sound: "none" });
        expect(typeof res.shown).toBe("boolean");
      });

      it("snapshot reports version and protocol 22", async () => {
        const snap = await herdr.snapshot();
        expect(snap.protocol).toBe(22);
        expect(snap.version).toMatch(/^\d+\.\d+\.\d+/);
      });
    });

    describe("eventos", () => {
      it("the per-pane subscription receives the agent's state changes", async () => {
        const { pane, name } = await agentInNewPane();
        const c = collect((on) => herdr.subscribe({ paneIds: [pane.paneId] }, on));
        try {
          await c.next((e) => e.type === "subscribed");
          await herdr.promptAgent({ name, text: "trabaja" });
          await c.next((e) => e.type === "agent_status_changed" && e.status === "working");
          await c.next(
            (e) => e.type === "agent_status_changed" && SETTLED.includes(e.status),
            c.events.findIndex((e) => e.type === "agent_status_changed" && e.status === "working"),
          );
          const changes = c.events.filter((e) => e.type === "agent_status_changed");
          expect(changes.every((e) => e.paneId === pane.paneId)).toBe(true);
        } finally {
          await c.sub.close();
        }
      });

      it("the lifecycle subscription sees the closed panes", async () => {
        const { rootPaneId } = await projectWorkspace();
        const pane = await herdr.splitPane({ paneId: rootPaneId });
        const c = collect((on) => herdr.subscribe({ lifecycle: true }, on));
        try {
          await c.next((e) => e.type === "subscribed");
          await herdr.closePane(pane.paneId);
          await c.next((e) => e.type === "pane_closed" && e.paneId === pane.paneId);
        } finally {
          await c.sub.close();
        }
      });

      it("if the stream closes it emits events_lost, re-subscribes and keeps receiving", async () => {
        const { pane, name } = await agentInNewPane();
        const c = collect((on) => herdr.subscribe({ paneIds: [pane.paneId] }, on));
        try {
          await c.next((e) => e.type === "subscribed");
          h.dropStreams();
          await c.next((e) => e.type === "events_lost");
          const lost = c.events.findIndex((e) => e.type === "events_lost");
          await c.next((e) => e.type === "subscribed", lost);

          const resubscribed = c.events.length;
          await herdr.promptAgent({ name, text: "otra vez" });
          await c.next(
            (e) => e.type === "agent_status_changed" && e.status === "working",
            resubscribed,
          );
        } finally {
          await c.sub.close();
        }
      });

      it("subscribing to a pane that does not exist fails without retrying", async () => {
        const { rootPaneId } = await projectWorkspace();
        const pane = await herdr.splitPane({ paneId: rootPaneId });
        await herdr.closePane(pane.paneId);
        const c = collect((on) => herdr.subscribe({ paneIds: [pane.paneId] }, on));
        try {
          const failed = await c.next((e) => e.type === "subscription_failed");
          expect(failed).toMatchObject({ code: "pane_not_found" });
          expect(c.events.map((e) => e.type)).toEqual(["subscription_failed"]);
        } finally {
          await c.sub.close();
        }
      });

      it("close() stops the subscription without events_lost", async () => {
        const { pane, name } = await agentInNewPane();
        const c = collect((on) => herdr.subscribe({ paneIds: [pane.paneId] }, on));
        await c.next((e) => e.type === "subscribed");
        await c.sub.close();
        const count = c.events.length;

        await herdr.promptAgent({
          name,
          text: "nadie escucha",
          wait: { timeoutMs: timeout - 1_000 },
        });
        expect(c.events.slice(count)).toEqual([]);
      });
    });
  });
}
