// Suite de contrato del adapter de GitHub: la misma corre contra el fake (pnpm test) y contra
// GitHub real en un repo sandbox (pnpm --filter @lunasq/adapters test:gh).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isGitHubError } from "./errors.ts";
import type { GitHubAdapter } from "./types.ts";

export interface GitHubContractHarness {
  adapter: GitHubAdapter;
  /** Un branch nuevo ya publicado con un commit sobre `base`, y el checkout donde vive. */
  newBranch(): Promise<{ cwd: string; head: string; base: string }>;
  /** Lo que hace el humano en GitHub. */
  merge(url: string): Promise<void>;
  close(url: string): Promise<void>;
  /** URL de un PR que no existe en el repo. */
  missingUrl: string;
  cleanup(): Promise<void>;
}

export function gitHubContract(
  name: string,
  setup: () => Promise<GitHubContractHarness>,
  opts: { timeoutMs?: number } = {},
): void {
  const timeout = opts.timeoutMs ?? 5_000;

  describe(`contrato del adapter de GitHub: ${name}`, { timeout }, () => {
    let h: GitHubContractHarness;
    let gh: GitHubAdapter;

    beforeAll(async () => {
      h = await setup();
      gh = h.adapter;
    }, 60_000);

    afterAll(async () => {
      await h?.cleanup();
    }, 60_000);

    async function openPr(title = "LunasQ contrato") {
      const branch = await h.newBranch();
      const { pr, created } = await gh.createPr({ ...branch, title, body: "cuerpo\n- [x] uno" });
      return { branch, pr, created };
    }

    it("createPr abre un PR y repetirlo devuelve el mismo", async () => {
      const { branch, pr, created } = await openPr();
      expect(created).toBe(true);
      expect(pr).toMatchObject({
        state: "open",
        headBranch: branch.head,
        baseBranch: branch.base,
        mergedAt: null,
      });
      const again = await gh.createPr({ ...branch, title: "otro título", body: "otro" });
      expect(again).toMatchObject({ created: false, pr: { url: pr.url, number: pr.number } });
      expect((await gh.findOpenPr(branch))?.url).toBe(pr.url);
      expect((await gh.getPr(pr.url)).url).toBe(pr.url);
    });

    it("findOpenPr da null para un branch sin PR", async () => {
      const branch = await h.newBranch();
      expect(await gh.findOpenPr(branch)).toBeNull();
    });

    it("getPr ve el merge con su hora", async () => {
      const { pr } = await openPr();
      await h.merge(pr.url);
      const merged = await gh.getPr(pr.url);
      expect(merged.state).toBe("merged");
      expect(merged.mergedAt).toBeInstanceOf(Date);
    });

    it("un PR cerrado sin merge no cuenta como abierto: createPr abre otro", async () => {
      const { branch, pr } = await openPr();
      await h.close(pr.url);
      const closed = await gh.getPr(pr.url);
      expect(closed).toMatchObject({ state: "closed", mergedAt: null });
      expect(closed.closedAt).toBeInstanceOf(Date);
      expect(await gh.findOpenPr(branch)).toBeNull();
      const next = await gh.createPr({ ...branch, title: "segundo intento", body: "b" });
      expect(next.created).toBe(true);
      expect(next.pr.url).not.toBe(pr.url);
      await h.close(next.pr.url);
    });

    it("getPr de un PR que no existe es not_found", async () => {
      const err = await gh.getPr(h.missingUrl).catch((e: unknown) => e);
      expect(isGitHubError(err, "not_found")).toBe(true);
    });
  });
}
