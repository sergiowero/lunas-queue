// Piezas compartidas por las páginas: estado de una tarea, carga y errores de consulta y escritura.
import type { SubState, TaskState } from "@lunasq/schemas";
import type { ComponentProps } from "react";
import { ApiError } from "../lib/api.ts";
import { STATE_LABEL, SUB_STATE_LABEL } from "../lib/format.ts";
import { Badge } from "./ui/badge.tsx";

/** Solo In progress va en azul y Needs human en rojo; el resto queda neutro. */
function stateVariant(state: TaskState): ComponentProps<typeof Badge>["variant"] {
  if (state === "in_progress") return "info";
  if (state === "needs_human") return "destructive";
  return "secondary";
}

export function StateBadges({ state, subState }: { state: TaskState; subState: SubState | null }) {
  return (
    <span className="inline-flex gap-1">
      <Badge variant={stateVariant(state)}>{STATE_LABEL[state]}</Badge>
      {subState && <Badge variant="outline">{SUB_STATE_LABEL[subState]}</Badge>}
    </span>
  );
}

export function stateText(position: { state: TaskState; subState: SubState | null }): string {
  const sub = position.subState ? ` · ${SUB_STATE_LABEL[position.subState]}` : "";
  return `${STATE_LABEL[position.state]}${sub}`;
}

export function Loading() {
  return <p className="text-sm text-muted-foreground">Cargando…</p>;
}

export function QueryError({ error }: { error: Error }) {
  return (
    <p role="alert" className="text-sm text-destructive">
      Error al cargar: {error.message}
    </p>
  );
}

/** Error de una escritura, con los issues de validación del servidor si los trae. */
export function MutationError({ error }: { error: Error }) {
  const issues = error instanceof ApiError ? error.issues : [];
  return (
    <div role="alert" className="text-sm text-destructive">
      <p>{error.message}</p>
      {issues.length > 0 && (
        <ul className="list-disc pl-5 font-mono text-xs">
          {issues.map((issue, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: los issues pueden repetirse y la lista no se reordena.
            <li key={i}>{`${issue.path.join(".") || "(raíz)"}: ${issue.message}`}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
