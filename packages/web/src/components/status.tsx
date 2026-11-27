// Pieces shared by the pages: a task's state, loading and query and write errors.
import type { SubState, TaskState } from "@lunasq/schemas";
import type { ComponentProps, ReactNode } from "react";
import { ApiError } from "../lib/api.ts";
import type { Dictionary } from "../lib/dictionary/index.ts";
import { useErrorText } from "../lib/error-text.ts";
import { useT } from "../lib/i18n.ts";
import { cn } from "../lib/utils.ts";
import { Badge } from "./ui/badge.tsx";

/** Only In progress is blue and Needs human red; the rest stays neutral. */
function stateVariant(state: TaskState): ComponentProps<typeof Badge>["variant"] {
  if (state === "in_progress") return "info";
  if (state === "needs_human") return "destructive";
  return "secondary";
}

/** A small dot before the sub-state: it pulses while an agent runs and is amber while a human is awaited. */
function SubStateDot({ subState }: { subState: SubState }) {
  if (subState === "running") {
    return (
      <span aria-hidden="true" className="relative inline-flex size-1.5">
        <span className="absolute inset-0 rounded-full bg-success animate-live-ping" />
        <span className="relative size-1.5 rounded-full bg-success" />
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-1.5 rounded-full",
        subState === "waiting_human" ? "bg-warning" : "bg-text-muted/60",
      )}
    />
  );
}

export function StateBadges({ state, subState }: { state: TaskState; subState: SubState | null }) {
  const t = useT();
  return (
    <span className="inline-flex gap-1">
      <Badge variant={stateVariant(state)}>{t.state[state]}</Badge>
      {subState && (
        <Badge variant="outline">
          <SubStateDot subState={subState} />
          {t.subState[subState]}
        </Badge>
      )}
    </span>
  );
}

export function stateText(
  position: { state: TaskState; subState: SubState | null },
  t: Dictionary,
): string {
  const sub = position.subState ? ` · ${t.subState[position.subState]}` : "";
  return `${t.state[position.state]}${sub}`;
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      className={cn("size-4 shrink-0 animate-spin text-primary-text", className)}
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.5" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Loading() {
  const t = useT();
  return (
    <p className="flex animate-fade-in items-center gap-2 py-2 text-sm text-muted-foreground">
      <Spinner />
      {t.common.loading}
    </p>
  );
}

function AlertIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="mt-px size-4 shrink-0"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 8v4M12 16h.01" />
    </svg>
  );
}

const alertBox =
  "flex items-start gap-2 rounded-lg border border-danger/25 bg-danger/[0.06] px-3 py-2 text-sm text-destructive";

export function QueryError({ error }: { error: Error }) {
  const t = useT();
  const errorText = useErrorText();
  return (
    <p role="alert" className={alertBox}>
      <AlertIcon />
      <span>{t.common.loadError(errorText(error))}</span>
    </p>
  );
}

/** What a list shows when it has nothing: a dashed box with the message. */
export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center justify-center rounded-xl border border-dashed border-border-strong/70 bg-surface/50 px-4 py-8 text-center text-sm text-muted-foreground">
      <p>{children}</p>
    </div>
  );
}

/** A write error, with the server's validation issues if it carries them. */
export function MutationError({ error }: { error: Error }) {
  const t = useT();
  const errorText = useErrorText();
  const issues = error instanceof ApiError ? error.issues : [];
  return (
    <div role="alert" className={alertBox}>
      <AlertIcon />
      <div className="flex min-w-0 flex-col gap-1">
        <p>{errorText(error)}</p>
        {issues.length > 0 && (
          <ul className="list-disc pl-5 font-mono text-xs">
            {issues.map((issue, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the issues can repeat and the list is not reordered.
              <li key={i}>{`${issue.path.join(".") || t.common.root}: ${issue.message}`}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
