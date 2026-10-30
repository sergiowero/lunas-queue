// Salida `--json` de `gh pr view` / `gh pr list` (gh 2.100) y su traducción a PullRequest.
// Los esquemas no son estrictos: gh agrega campos entre versiones y solo se leen los que se usan.
import { z } from "zod";
import { GitHubError } from "./errors.ts";
import type {
  CheckStatus,
  ChecksStatus,
  PrCheck,
  PrReview,
  PullRequest,
  ReviewDecision,
  ReviewState,
} from "./types.ts";

/** Campos que se piden a `gh pr view --json` y `gh pr list --json`. */
export const PR_FIELDS = [
  "number",
  "url",
  "state",
  "isDraft",
  "headRefName",
  "baseRefName",
  "mergedAt",
  "closedAt",
  "statusCheckRollup",
  "reviewDecision",
  "reviews",
  "labels",
].join(",");

// gh da "" o una fecha cero en lugar de null en algunos campos.
const optionalDate = z
  .string()
  .nullish()
  .transform((s) => {
    if (!s || s.startsWith("0001-")) return null;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  });

const CheckRun = z.object({
  __typename: z.literal("CheckRun"),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullish(),
  detailsUrl: z.string().nullish(),
});

const StatusContext = z.object({
  __typename: z.literal("StatusContext"),
  context: z.string(),
  state: z.string(),
  targetUrl: z.string().nullish(),
});

const GhPr = z.object({
  number: z.int().positive(),
  url: z.url(),
  state: z.enum(["OPEN", "MERGED", "CLOSED"]),
  isDraft: z.boolean(),
  headRefName: z.string(),
  baseRefName: z.string(),
  mergedAt: optionalDate,
  closedAt: optionalDate,
  // Checks y reviews se leen entrada por entrada (parseCheck, parseReview): una forma que no se
  // conoce no debe impedir leer el estado del PR, o el poller nunca vería el merge.
  statusCheckRollup: z.array(z.unknown()).nullish(),
  reviewDecision: z.string().nullish(),
  reviews: z.array(z.unknown()).nullish(),
  labels: z.array(z.unknown()).nullish(),
});

const Label = z.object({ name: z.string() });

const Check = z.discriminatedUnion("__typename", [CheckRun, StatusContext]);

const Review = z.object({
  author: z.object({ login: z.string() }).nullish(),
  state: z.string(),
  submittedAt: optionalDate,
});

const SUCCESS = new Set(["SUCCESS", "NEUTRAL"]);
const SKIPPED = new Set(["SKIPPED"]);

function checkRunStatus(status: string, conclusion: string | null | undefined): CheckStatus {
  if (status !== "COMPLETED") return "pending";
  if (conclusion && SUCCESS.has(conclusion)) return "success";
  if (conclusion && SKIPPED.has(conclusion)) return "skipped";
  // FAILURE, TIMED_OUT, CANCELLED, ACTION_REQUIRED, STARTUP_FAILURE, STALE.
  return "failure";
}

function statusContextStatus(state: string): CheckStatus {
  if (state === "SUCCESS") return "success";
  if (state === "PENDING" || state === "EXPECTED") return "pending";
  return "failure";
}

/** Resumen de los checks: falla si uno falla; pendiente si uno no terminó. */
export function summarizeChecks(items: readonly PrCheck[]): ChecksStatus {
  if (items.length === 0) return "none";
  if (items.some((c) => c.status === "failure")) return "failure";
  if (items.some((c) => c.status === "pending")) return "pending";
  return "success";
}

const REVIEW_STATES: Record<string, ReviewState> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes_requested",
  COMMENTED: "commented",
  DISMISSED: "dismissed",
  PENDING: "pending",
};

const REVIEW_DECISIONS: Record<string, ReviewDecision> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes_requested",
  REVIEW_REQUIRED: "review_required",
};

/** Un check de forma desconocida cuenta como pendiente: no se puede afirmar que pasó. */
function parseCheck(raw: unknown): PrCheck {
  const c = Check.safeParse(raw);
  if (!c.success) return { name: "desconocido", status: "pending", url: null };
  return c.data.__typename === "CheckRun"
    ? {
        name: c.data.name,
        status: checkRunStatus(c.data.status, c.data.conclusion),
        url: c.data.detailsUrl ?? null,
      }
    : {
        name: c.data.context,
        status: statusContextStatus(c.data.state),
        url: c.data.targetUrl ?? null,
      };
}

/** Una review de forma desconocida se descarta. */
function parseReview(raw: unknown): PrReview[] {
  const r = Review.safeParse(raw);
  if (!r.success) return [];
  return [
    {
      author: r.data.author?.login ?? "",
      state: REVIEW_STATES[r.data.state] ?? "commented",
      submittedAt: r.data.submittedAt,
    },
  ];
}

export function parsePr(raw: unknown): PullRequest {
  const result = GhPr.safeParse(raw);
  if (!result.success) {
    throw new GitHubError("invalid_output", `PR inesperado: ${result.error.message}`, {
      cause: result.error,
    });
  }
  const pr = result.data;
  const items = (pr.statusCheckRollup ?? []).map(parseCheck);
  const reviews = (pr.reviews ?? []).flatMap(parseReview);
  return {
    number: pr.number,
    url: pr.url,
    state: pr.state === "OPEN" ? "open" : pr.state === "MERGED" ? "merged" : "closed",
    isDraft: pr.isDraft,
    headBranch: pr.headRefName,
    baseBranch: pr.baseRefName,
    mergedAt: pr.mergedAt,
    closedAt: pr.closedAt,
    checks: { status: summarizeChecks(items), items },
    reviewDecision: REVIEW_DECISIONS[pr.reviewDecision ?? ""] ?? null,
    reviews,
    labels: (pr.labels ?? []).flatMap((raw) => {
      const label = Label.safeParse(raw);
      return label.success ? [label.data.name] : [];
    }),
  };
}

export function parsePrList(raw: unknown): PullRequest[] {
  if (!Array.isArray(raw)) throw new GitHubError("invalid_output", "se esperaba una lista de PRs");
  return raw.map(parsePr);
}
