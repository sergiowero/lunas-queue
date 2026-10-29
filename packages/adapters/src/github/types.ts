// Puerto del adapter de GitHub (ADR uw-14-adapter-github). Solo por el CLI `gh` con la sesión
// autenticada de la máquina (docs/tech-stack.md). RealGitHub y FakeGitHub lo cumplen y pasan la
// misma suite.
import type { PrState } from "@lunasq/schemas";

/** Resumen de CI: none sin checks; failure si alguno falló; pending si alguno no terminó. */
export type ChecksStatus = "none" | "pending" | "success" | "failure";

export type CheckStatus = "pending" | "success" | "failure" | "skipped";

export interface PrCheck {
  name: string;
  status: CheckStatus;
  url: string | null;
}

export type ReviewState = "approved" | "changes_requested" | "commented" | "dismissed" | "pending";

export interface PrReview {
  author: string;
  state: ReviewState;
  submittedAt: Date | null;
}

/** null si el repo no exige reviews. */
export type ReviewDecision = "approved" | "changes_requested" | "review_required" | null;

export interface PullRequest {
  number: number;
  url: string;
  state: PrState;
  isDraft: boolean;
  headBranch: string;
  baseBranch: string;
  mergedAt: Date | null;
  closedAt: Date | null;
  checks: { status: ChecksStatus; items: PrCheck[] };
  reviewDecision: ReviewDecision;
  reviews: PrReview[];
}

export interface CreatePrInput {
  /** Checkout del repo (el worktree de la tarea); `gh` toma el repo de su remoto. */
  cwd: string;
  /** Branch ya publicado en el remoto. */
  head: string;
  base: string;
  title: string;
  body: string;
  draft?: boolean;
}

export interface GitHubAdapter {
  /**
   * Abre el PR de `head` hacia `base`. Idempotente: si ya hay uno abierto, lo devuelve con
   * `created: false`. Uno cerrado o mergeado no cuenta: se abre otro.
   */
  createPr(input: CreatePrInput): Promise<{ pr: PullRequest; created: boolean }>;
  /** PR abierto de `head` hacia `base`, o null. */
  findOpenPr(input: { cwd: string; head: string; base: string }): Promise<PullRequest | null>;
  /** Estado, CI y reviews de un PR por su URL. Lanza GitHubError `not_found` si no existe. */
  getPr(url: string): Promise<PullRequest>;
}
