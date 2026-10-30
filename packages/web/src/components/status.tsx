// Piezas compartidas por las páginas: estado de una tarea, carga y errores de consulta.
import type { SubState, TaskState } from "@lunasq/schemas";
import { STATE_LABEL, SUB_STATE_LABEL } from "../lib/format.ts";
import { Badge } from "./ui/badge.tsx";

export function StateBadges({ state, subState }: { state: TaskState; subState: SubState | null }) {
  return (
    <span className="inline-flex gap-1">
      <Badge variant={state === "needs_human" ? "destructive" : "secondary"}>
        {STATE_LABEL[state]}
      </Badge>
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
