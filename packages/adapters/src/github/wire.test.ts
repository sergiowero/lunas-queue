import { describe, expect, it } from "vitest";
import { parsePr, parsePrList, summarizeChecks } from "./wire.ts";

// Real output of `gh pr view 10 --json …` with gh 2.100.0 (an extra field that is ignored).
const merged = {
  closedAt: "2026-10-29T15:47:34Z",
  headRefName: "uw-09-worktrees",
  baseRefName: "main",
  isDraft: false,
  mergedAt: "2026-10-29T15:47:34Z",
  mergeable: "UNKNOWN",
  number: 10,
  reviewDecision: "",
  reviews: [],
  state: "MERGED",
  statusCheckRollup: [
    {
      __typename: "CheckRun",
      completedAt: "2026-10-29T15:45:52Z",
      conclusion: "SUCCESS",
      detailsUrl: "https://github.com/sergiowero/lunas-queue/actions/runs/1/job/2",
      name: "check",
      startedAt: "2026-10-29T15:45:23Z",
      status: "COMPLETED",
      workflowName: "CI",
    },
  ],
  url: "https://github.com/sergiowero/lunas-queue/pull/10",
  title: "UW-09: Ciclo de vida de worktrees",
};

const open = {
  ...merged,
  number: 12,
  url: "https://github.com/sergiowero/lunas-queue/pull/12",
  state: "OPEN",
  mergedAt: null,
  closedAt: null,
  reviewDecision: "CHANGES_REQUESTED",
  reviews: [
    {
      author: { login: "revisora" },
      state: "CHANGES_REQUESTED",
      submittedAt: "2026-10-29T16:00:00Z",
      body: "falta un test",
    },
    { author: null, state: "COMMENTED", submittedAt: "" },
  ],
  statusCheckRollup: [
    { __typename: "CheckRun", name: "check", status: "IN_PROGRESS", conclusion: "" },
    { __typename: "CheckRun", name: "e2e", status: "COMPLETED", conclusion: "SKIPPED" },
    {
      __typename: "StatusContext",
      context: "ci/legacy",
      state: "SUCCESS",
      targetUrl: "https://ci.example/1",
    },
  ],
};

describe("parsePr", () => {
  it("translates a merged PR with its CI", () => {
    expect(parsePr(merged)).toEqual({
      number: 10,
      url: merged.url,
      state: "merged",
      isDraft: false,
      headBranch: "uw-09-worktrees",
      baseBranch: "main",
      mergedAt: new Date("2026-10-29T15:47:34Z"),
      closedAt: new Date("2026-10-29T15:47:34Z"),
      mergeable: "unknown",
      checks: {
        status: "success",
        items: [{ name: "check", status: "success", url: merged.statusCheckRollup[0]?.detailsUrl }],
      },
      reviewDecision: null,
      reviews: [],
      labels: [],
    });
  });

  it("reads the label names and discards those of unknown shape", () => {
    const labeled = {
      ...merged,
      labels: [{ name: "lunasq:risk-low", color: "0e8a16" }, { id: 1 }, "raro"],
    };
    expect(parsePr(labeled).labels).toEqual(["lunasq:risk-low"]);
  });

  it("reads whether the PR clashes with the base; an absent or unknown value is unknown", () => {
    expect(parsePr({ ...open, mergeable: "CONFLICTING" }).mergeable).toBe("conflicting");
    expect(parsePr({ ...open, mergeable: "MERGEABLE" }).mergeable).toBe("mergeable");
    expect(parsePr({ ...open, mergeable: "OTRO" }).mergeable).toBe("unknown");
    const { mergeable: _, ...sinCampo } = open;
    expect(parsePr(sinCampo).mergeable).toBe("unknown");
  });

  it("translates pending, skipped and status checks, and the reviews", () => {
    const pr = parsePr(open);
    expect(pr.state).toBe("open");
    expect(pr.mergedAt).toBeNull();
    expect(pr.checks).toEqual({
      status: "pending",
      items: [
        { name: "check", status: "pending", url: null },
        { name: "e2e", status: "skipped", url: null },
        { name: "ci/legacy", status: "success", url: "https://ci.example/1" },
      ],
    });
    expect(pr.reviewDecision).toBe("changes_requested");
    expect(pr.reviews).toEqual([
      {
        author: "revisora",
        state: "changes_requested",
        submittedAt: new Date("2026-10-29T16:00:00Z"),
      },
      { author: "", state: "commented", submittedAt: null },
    ]);
  });

  it("a PR closed without merge and without checks", () => {
    const pr = parsePr({
      ...open,
      state: "CLOSED",
      statusCheckRollup: [],
      closedAt: "2026-10-30T00:00:00Z",
    });
    expect(pr).toMatchObject({
      state: "closed",
      mergedAt: null,
      checks: { status: "none", items: [] },
    });
    expect(pr.closedAt).toEqual(new Date("2026-10-30T00:00:00Z"));
  });

  it("a check or review of unknown shape does not prevent reading the state", () => {
    const pr = parsePr({
      ...merged,
      statusCheckRollup: [
        { __typename: "CheckSuite", id: 1 },
        { __typename: "CheckRun", name: null },
      ],
      reviews: [{ state: 3 }, { author: { login: "ana" }, state: "APPROVED", submittedAt: null }],
    });
    expect(pr.state).toBe("merged");
    expect(pr.checks).toEqual({
      status: "pending",
      items: [
        { name: "unknown", status: "pending", url: null },
        { name: "unknown", status: "pending", url: null },
      ],
    });
    expect(pr.reviews).toEqual([{ author: "ana", state: "approved", submittedAt: null }]);
  });

  it("rejects an output with an unexpected shape", () => {
    expect(() => parsePr({ ...merged, state: "DRAFT" })).toThrow(
      expect.objectContaining({ code: "invalid_output" }),
    );
    expect(() => parsePrList({})).toThrow(expect.objectContaining({ code: "invalid_output" }));
  });
});

describe("summarizeChecks", () => {
  const c = (status: "pending" | "success" | "failure" | "skipped") => ({
    name: status,
    status,
    url: null,
  });

  it("a failure beats everything and a pending beats the successful ones", () => {
    expect(summarizeChecks([])).toBe("none");
    expect(summarizeChecks([c("success"), c("skipped")])).toBe("success");
    expect(summarizeChecks([c("success"), c("pending")])).toBe("pending");
    expect(summarizeChecks([c("pending"), c("failure")])).toBe("failure");
  });

  it("parsePr translates the failure conclusions of a CheckRun", () => {
    for (const conclusion of ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"]) {
      const pr = parsePr({
        ...merged,
        statusCheckRollup: [{ __typename: "CheckRun", name: "x", status: "COMPLETED", conclusion }],
      });
      expect(pr.checks.status).toBe("failure");
    }
    const pr = parsePr({
      ...merged,
      statusCheckRollup: [{ __typename: "StatusContext", context: "x", state: "ERROR" }],
    });
    expect(pr.checks.status).toBe("failure");
  });
});
