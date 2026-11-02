// Piezas compartidas por las páginas: estado de una tarea, carga y errores de consulta y escritura.
import type { SubState, TaskState } from "@lunasq/schemas";
import type { ComponentProps } from "react";
import { ApiError } from "../lib/api.ts";
import type { Dictionary } from "../lib/dictionary/index.ts";
import { useErrorText } from "../lib/error-text.ts";
import { useT } from "../lib/i18n.ts";
import { Badge } from "./ui/badge.tsx";

/** Solo In progress va en azul y Needs human en rojo; el resto queda neutro. */
function stateVariant(state: TaskState): ComponentProps<typeof Badge>["variant"] {
  if (state === "in_progress") return "info";
  if (state === "needs_human") return "destructive";
  return "secondary";
}

export function StateBadges({ state, subState }: { state: TaskState; subState: SubState | null }) {
  const t = useT();
  return (
    <span className="inline-flex gap-1">
      <Badge variant={stateVariant(state)}>{t.state[state]}</Badge>
      {subState && <Badge variant="outline">{t.subState[subState]}</Badge>}
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

export function Loading() {
  const t = useT();
  return <p className="text-sm text-muted-foreground">{t.common.loading}</p>;
}

export function QueryError({ error }: { error: Error }) {
  const t = useT();
  const errorText = useErrorText();
  return (
    <p role="alert" className="text-sm text-destructive">
      {t.common.loadError(errorText(error))}
    </p>
  );
}

/** Error de una escritura, con los issues de validación del servidor si los trae. */
export function MutationError({ error }: { error: Error }) {
  const t = useT();
  const errorText = useErrorText();
  const issues = error instanceof ApiError ? error.issues : [];
  return (
    <div role="alert" className="text-sm text-destructive">
      <p>{errorText(error)}</p>
      {issues.length > 0 && (
        <ul className="list-disc pl-5 font-mono text-xs">
          {issues.map((issue, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: los issues pueden repetirse y la lista no se reordena.
            <li key={i}>{`${issue.path.join(".") || t.common.root}: ${issue.message}`}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
