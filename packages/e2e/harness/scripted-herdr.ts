// herdr falso con worktrees de git reales y agentes guionados. Cada prompt que recibe un agente
// (el de fase, y la respuesta a una pregunta) dispara `onPrompt` en segundo plano; cuando el
// guion termina el turno, el agente queda `done`, como Claude Code al terminar de responder.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { FakeHerdr, type HerdrAdapter } from "@lunasq/adapters";
import { git } from "./git.ts";

export interface PromptedAgent {
  name: string;
  paneId: string;
  /** Cwd del pane: el worktree de la tarea. */
  cwd: string;
  env: Record<string, string>;
  args: string[];
  text: string;
}

export interface ScriptedHerdrOptions {
  /** Checkout del proyecto: de ahí salen los worktrees. */
  repo: string;
  /** Carpeta de los worktrees de las tareas. */
  worktrees: string;
  onPrompt: (agent: PromptedAgent) => Promise<void>;
  onError: (error: Error, agent: string) => void;
}

// Un prompt nunca vence solo: el turno termina cuando el guion lo cierra.
const NEVER = 2 ** 31 - 1;

export class ScriptedHerdr extends FakeHerdr implements HerdrAdapter {
  readonly #opts: ScriptedHerdrOptions;
  readonly #running = new Set<Promise<void>>();

  constructor(opts: ScriptedHerdrOptions) {
    super({ promptDurationMs: NEVER });
    this.#opts = opts;
  }

  override async ensureWorktree(input: Parameters<FakeHerdr["ensureWorktree"]>[0]) {
    const path = join(this.#opts.worktrees, input.branch.replaceAll("/", "-"));
    const result = await super.ensureWorktree({ ...input, path });
    if (!existsSync(path)) {
      const { repo } = this.#opts;
      const exists = git(repo, "branch", "--list", input.branch) !== "";
      if (exists) git(repo, "worktree", "add", path, input.branch);
      else git(repo, "worktree", "add", "-b", input.branch, path, input.base);
    }
    return result;
  }

  override async removeWorktree(input: Parameters<FakeHerdr["removeWorktree"]>[0]) {
    const known = (await this.snapshot()).workspaces.find(
      (w) => w.workspaceId === input.workspaceId,
    );
    await super.removeWorktree(input);
    if (known?.checkoutPath && existsSync(known.checkoutPath)) {
      git(this.#opts.repo, "worktree", "remove", "--force", known.checkoutPath);
    }
  }

  override async promptAgent(input: Parameters<FakeHerdr["promptAgent"]>[0]) {
    const agent = await super.promptAgent(input);
    const snapshot = await this.snapshot();
    const pane = snapshot.panes.find((p) => p.paneId === agent.paneId);
    const job = this.#opts
      .onPrompt({
        name: input.name,
        paneId: agent.paneId,
        cwd: pane?.cwd ?? "",
        env: this.paneEnv(agent.paneId),
        args: this.agentArgs(input.name),
        text: input.text,
      })
      .catch((error: unknown) =>
        this.#opts.onError(error instanceof Error ? error : new Error(String(error)), input.name),
      )
      .then(async () => {
        // El agente pudo cerrarse mientras tanto (cerrar el Run libera su pane).
        if (await this.getAgent(input.name)) this.setAgentStatus(input.name, "done");
      });
    this.#running.add(job);
    void job.finally(() => this.#running.delete(job));
    return agent;
  }

  /** Espera a que terminen los guiones en curso. */
  async idle(): Promise<void> {
    while (this.#running.size > 0) await Promise.all([...this.#running]);
  }
}
