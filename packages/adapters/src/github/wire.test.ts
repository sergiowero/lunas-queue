import { describe, expect, it } from "vitest";
import { parsePr, parsePrList, summarizeChecks } from "./wire.ts";

// Salida real de `gh pr view 10 --json …` con gh 2.100.0 (un campo extra que se ignora).
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
  it("traduce un PR mergeado con su CI", () => {
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

  it("lee los nombres de las etiquetas y descarta las de forma desconocida", () => {
    const labeled = {
      ...merged,
      labels: [{ name: "lunasq:risk-low", color: "0e8a16" }, { id: 1 }, "raro"],
    };
    expect(parsePr(labeled).labels).toEqual(["lunasq:risk-low"]);
  });

  it("lee si el PR choca con la base; un valor ausente o desconocido es unknown", () => {
    expect(parsePr({ ...open, mergeable: "CONFLICTING" }).mergeable).toBe("conflicting");
    expect(parsePr({ ...open, mergeable: "MERGEABLE" }).mergeable).toBe("mergeable");
    expect(parsePr({ ...open, mergeable: "OTRO" }).mergeable).toBe("unknown");
    const { mergeable: _, ...sinCampo } = open;
    expect(parsePr(sinCampo).mergeable).toBe("unknown");
  });

  it("traduce checks pendientes, saltados y de status, y las reviews", () => {
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

  it("un PR cerrado sin merge y sin checks", () => {
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

  it("un check o una review de forma desconocida no impide leer el estado", () => {
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
        { name: "desconocido", status: "pending", url: null },
        { name: "desconocido", status: "pending", url: null },
      ],
    });
    expect(pr.reviews).toEqual([{ author: "ana", state: "approved", submittedAt: null }]);
  });

  it("rechaza una salida con forma inesperada", () => {
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

  it("una falla gana a todo y un pendiente a los exitosos", () => {
    expect(summarizeChecks([])).toBe("none");
    expect(summarizeChecks([c("success"), c("skipped")])).toBe("success");
    expect(summarizeChecks([c("success"), c("pending")])).toBe("pending");
    expect(summarizeChecks([c("pending"), c("failure")])).toBe("failure");
  });

  it("parsePr traduce las conclusiones de falla de un CheckRun", () => {
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
