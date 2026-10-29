import { describe, expect, it } from "vitest";
import { gitHubContract } from "./contract.ts";
import { GitHubError } from "./errors.ts";
import { FakeGitHub } from "./fake.ts";

gitHubContract("fake en memoria", async () => {
  const adapter = new FakeGitHub();
  let branches = 0;
  return {
    adapter,
    newBranch: async () => ({ cwd: "/repo", head: `lunasq/t${++branches}`, base: "main" }),
    merge: async (url) => adapter.merge(url),
    close: async (url) => adapter.close(url),
    missingUrl: "https://github.com/lunasq/fake/pull/999",
    cleanup: async () => {},
  };
});

// Controles propios del fake, que usan el poller y la entrega en sus tests.
describe("FakeGitHub: controles de test", () => {
  const input = { cwd: "/repo", head: "lunasq/t1", base: "main", title: "t", body: "b" };

  it("setChecks y addReview se ven en getPr", async () => {
    const fake = new FakeGitHub();
    const { pr } = await fake.createPr(input);
    fake.setChecks(pr.url, [
      { name: "ci", status: "success", url: null },
      { name: "e2e", status: "failure", url: "https://ci/1" },
    ]);
    const at = new Date("2026-10-29T12:00:00Z");
    fake.addReview(pr.url, { author: "ana", state: "approved", submittedAt: at }, "approved");
    const read = await fake.getPr(pr.url);
    expect(read.checks.status).toBe("failure");
    expect(read.reviews).toEqual([{ author: "ana", state: "approved", submittedAt: at }]);
    expect(read.reviewDecision).toBe("approved");
  });

  it("merge usa la hora dada, reopen reabre un cerrado y failGetPr inyecta fallos", async () => {
    const fake = new FakeGitHub({ repo: "o/r" });
    const { pr } = await fake.createPr(input);
    expect(pr.url).toBe("https://github.com/o/r/pull/1");
    fake.close(pr.url);
    fake.reopen(pr.url);
    expect((await fake.getPr(pr.url)).state).toBe("open");
    fake.failGetPr(pr.url, new GitHubError("timeout", "lento"));
    await expect(fake.getPr(pr.url)).rejects.toMatchObject({ code: "timeout" });
    fake.failGetPr(pr.url, null);
    const at = new Date("2026-10-29T17:54:13Z");
    fake.merge(pr.url, at);
    expect(await fake.getPr(pr.url)).toMatchObject({ state: "merged", mergedAt: at });
    expect(() => fake.merge(pr.url)).toThrow();
    expect(fake.created).toHaveLength(1);
  });

  it("getPr devuelve copias: modificarlas no cambia el fake", async () => {
    const fake = new FakeGitHub();
    const { pr } = await fake.createPr(input);
    pr.state = "merged";
    expect((await fake.getPr(pr.url)).state).toBe("open");
  });
});
