// Contract suite of the GitHub adapter: the same one runs against the fake (pnpm test) and against
// GitHub real en un repo sandbox (pnpm --filter @lunasq/adapters test:gh).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isGitHubError } from "./errors.ts";
import type { GitHubAdapter } from "./types.ts";

export interface GitHubContractHarness {
  adapter: GitHubAdapter;
  /** A new branch already published with a commit on top of `base`, and the checkout where it lives. */
  newBranch(): Promise<{ cwd: string; head: string; base: string }>;
  /** What the human does on GitHub. */
  merge(url: string): Promise<void>;
  close(url: string): Promise<void>;
  /** URL of a PR that does not exist in the repo. */
  missingUrl: string;
  cleanup(): Promise<void>;
}

export function gitHubContract(
  name: string,
  setup: () => Promise<GitHubContractHarness>,
  opts: { timeoutMs?: number } = {},
): void {
  const timeout = opts.timeoutMs ?? 5_000;

  describe(`GitHub adapter contract: ${name}`, { timeout }, () => {
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

    it("createPr opens a PR and repeating it returns the same one", async () => {
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

    it("addLabels sets the labels, also those the repo did not have, and repeating it does not duplicate", async () => {
      const { branch, pr } = await openPr();
      const label = { name: "lunasq:risk-low", color: "0e8a16", description: "Riesgo bajo" };
      const labeled = await gh.addLabels({ cwd: branch.cwd, url: pr.url, labels: [label] });
      expect(labeled.labels).toEqual(["lunasq:risk-low"]);
      const again = await gh.addLabels({ cwd: branch.cwd, url: pr.url, labels: [label] });
      expect(again.labels).toEqual(["lunasq:risk-low"]);
      expect((await gh.getPr(pr.url)).labels).toEqual(["lunasq:risk-low"]);
    });

    it("findOpenPr gives null for a branch without a PR", async () => {
      const branch = await h.newBranch();
      expect(await gh.findOpenPr(branch)).toBeNull();
    });

    it("getPr sees the merge with its time", async () => {
      const { pr } = await openPr();
      await h.merge(pr.url);
      const merged = await gh.getPr(pr.url);
      expect(merged.state).toBe("merged");
      expect(merged.mergedAt).toBeInstanceOf(Date);
    });

    it("a PR closed without merge does not count as open: createPr opens another", async () => {
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

    it("getPr of a PR that does not exist is not_found", async () => {
      const err = await gh.getPr(h.missingUrl).catch((e: unknown) => e);
      expect(isGitHubError(err, "not_found")).toBe(true);
    });
  });
}
