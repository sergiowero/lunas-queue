import { describe, expect, it } from "vitest";
import {
  commitTrailers,
  deliveryFacts,
  MAX_PR_BODY_CHARS,
  prBody,
  prTitle,
  riskPrLabel,
} from "./delivery.ts";

const criteria = [
  {
    id: "AC-1",
    given: "a pending order",
    when: "it is cancelled",
    outcome: "it ends up cancelled",
  },
  { id: "AC-2", given: "a shipped order", when: "it is cancelled", outcome: "it is rejected" },
];

const verification = (
  verdicts: ("pass" | "fail")[],
  verdict: "pass" | "reject" = "pass",
  reviewers: Record<string, { status: "ran" | "skipped"; justification?: string }> = {},
) => ({
  verdict,
  criteriaVerdicts: verdicts.map((v, i) => ({
    criterionId: `AC-${i + 1}`,
    verdict: v,
    evidence: `test of criterion ${i + 1}`,
  })),
  reviewers,
  refuted: [{ reason: "falso positivo" }],
  riskLabel: "medium" as const,
});

describe("deliveryFacts", () => {
  const implementation = {
    criterionTests: [
      { criterionId: "AC-1", tests: [{}] },
      { criterionId: "AC-2", tests: [{}] },
    ],
  };

  it("a pass with every criterion at pass and with a test is complete", () => {
    expect(
      deliveryFacts({ criteria, implementation, verification: verification(["pass", "pass"]) }),
    ).toEqual({
      verifierPassed: true,
      testsCoherent: true,
      allCriteriaPassed: true,
    });
  });

  it("a criterion without a verdict or at fail does not count as passed", () => {
    expect(
      deliveryFacts({ criteria, implementation, verification: verification(["pass"]) })
        .allCriteriaPassed,
    ).toBe(false);
    expect(
      deliveryFacts({ criteria, implementation, verification: verification(["pass", "fail"]) })
        .allCriteriaPassed,
    ).toBe(false);
  });

  it("a criterion without tests, or without an implementation handoff, is not coherent", () => {
    const partial = { criterionTests: [{ criterionId: "AC-1", tests: [{}] }] };
    const v = verification(["pass", "pass"]);
    expect(
      deliveryFacts({ criteria, implementation: partial, verification: v }).testsCoherent,
    ).toBe(false);
    expect(
      deliveryFacts({
        criteria,
        implementation: {
          criterionTests: [
            { criterionId: "AC-1", tests: [{}] },
            { criterionId: "AC-2", tests: [] },
          ],
        },
        verification: v,
      }).testsCoherent,
    ).toBe(false);
    expect(deliveryFacts({ criteria, implementation: null, verification: v }).testsCoherent).toBe(
      false,
    );
  });

  it("a reject is not a verifier pass", () => {
    expect(
      deliveryFacts({
        criteria,
        implementation,
        verification: verification(["pass", "pass"], "reject"),
      }).verifierPassed,
    ).toBe(false);
  });
});

describe("commitTrailers", () => {
  const runs = [
    { id: "impl-1", phase: "implement" as const, startedAt: new Date("2026-01-01T10:00:00Z") },
    { id: "verify-1", phase: "verify" as const, startedAt: new Date("2026-01-01T11:00:00Z") },
    { id: "impl-2", phase: "implement" as const, startedAt: new Date("2026-01-01T12:00:00Z") },
  ];

  it("each commit carries the task and the implementation Run that was alive when it was created", () => {
    const commits = [
      { sha: "a", authoredAt: new Date("2026-01-01T10:30:00Z") },
      { sha: "b", authoredAt: new Date("2026-01-01T12:30:00Z") },
    ];
    expect(commitTrailers({ taskId: "t1", commits, runs, fallbackRunId: "verify-9" })).toEqual({
      a: { "LunasQ-Task": "t1", "LunasQ-Run": "impl-1" },
      b: { "LunasQ-Task": "t1", "LunasQ-Run": "impl-2" },
    });
  });

  it("a commit before every implementation Run uses the first one; without Runs, the fallback", () => {
    const early = [{ sha: "a", authoredAt: new Date("2025-12-31T00:00:00Z") }];
    expect(commitTrailers({ taskId: "t1", commits: early, runs, fallbackRunId: "v" }).a).toEqual({
      "LunasQ-Task": "t1",
      "LunasQ-Run": "impl-1",
    });
    expect(
      commitTrailers({ taskId: "t1", commits: early, runs: [], fallbackRunId: "v" }).a,
    ).toEqual({
      "LunasQ-Task": "t1",
      "LunasQ-Run": "v",
    });
  });
});

describe("prTitle", () => {
  it("uses the first line of the goal, without extra spaces", () => {
    expect(prTitle("  Allow   cancelling orders\n\nwith a reason")).toBe("Allow cancelling orders");
  });

  it("truncates to 72 characters", () => {
    const title = prTitle("x".repeat(200));
    expect(title).toHaveLength(72);
    expect(title.endsWith("…")).toBe(true);
  });

  it("prefers the task title over the goal", () => {
    expect(prTitle("Allow cancelling orders\n\nwith a reason", "  Cancel   orders ")).toBe(
      "Cancel orders",
    );
  });

  it("without a title (null or empty) falls back to the goal", () => {
    expect(prTitle("Allow cancelling orders", null)).toBe("Allow cancelling orders");
    expect(prTitle("Allow cancelling orders", " ")).toBe("Allow cancelling orders");
  });

  it("an empty goal gives a generic title", () => {
    expect(prTitle("  \n ")).toBe("LunasQ task");
  });
});

describe("riskPrLabel", () => {
  it("one label per risk level, with a distinct color", () => {
    const labels = (["low", "medium", "high"] as const).map(riskPrLabel);
    expect(labels.map((l) => l.name)).toEqual([
      "lunasq:risk-low",
      "lunasq:risk-medium",
      "lunasq:risk-high",
    ]);
    expect(new Set(labels.map((l) => l.color)).size).toBe(3);
  });
});

describe("prBody", () => {
  const input = {
    taskId: "t1",
    runId: "verify-1",
    goal: "Allow cancelling orders",
    specVersion: 2,
    criteria,
    verification: verification(["pass", "pass"], "pass", {
      "lunasq-security-reviewer": { status: "ran" },
      "lunasq-ux-reviewer": { status: "skipped", justification: "no UI" },
    }),
    evidencePath: "lunasq/tasks/t1.md",
    baseBranch: "main",
  };

  it("includes goal, criteria with their evidence, risk and trailers", () => {
    const body = prBody(input);
    expect(body).toContain("## Goal\n\nAllow cancelling orders");
    expect(body).toContain("**AC-1**");
    expect(body).toContain("a pending order");
    expect(body).toContain("test of criterion 1");
    expect(body).toContain("Risk: **medium**");
    expect(body).toContain("LunasQ-Task: t1");
    expect(body).toContain("LunasQ-Run: verify-1");
    expect(body).toContain("`lunasq/tasks/t1.md`");
  });

  it("lists the reviewers that ran and the skipped ones with their justification", () => {
    const body = prBody(input);
    expect(body).toContain("lunasq-security-reviewer");
    expect(body).toContain("lunasq-ux-reviewer");
    expect(body).toContain("no UI");
    expect(body).toContain("1 finding refuted");
  });

  it("a huge body is truncated with a notice", () => {
    const body = prBody({
      ...input,
      verification: {
        ...input.verification,
        criteriaVerdicts: input.verification.criteriaVerdicts.map((c) => ({
          ...c,
          evidence: "e".repeat(MAX_PR_BODY_CHARS),
        })),
      },
    });
    expect(body.length).toBeLessThanOrEqual(MAX_PR_BODY_CHARS);
    expect(body).toContain("LunasQ-Task: t1");
  });
});
