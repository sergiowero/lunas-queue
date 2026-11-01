// Pane id de un Run como botón que lo enfoca en herdr (ADR runs-foco-pane). Lo comparten el panel
// de Runs y la pestaña En curso. Un Run sin pane o sin nombre de agente no se puede enfocar y la
// celda sigue mostrando «—» como texto.

import type { RunView } from "@lunasq/schemas";
import { useMutation } from "@tanstack/react-query";
import { api, type Json } from "../lib/api.ts";
import { MutationError } from "./status.tsx";
import { Button } from "./ui/button.tsx";

type FocusableRun = Pick<Json<RunView>, "id" | "herdrPane" | "herdrName">;

export function PaneFocusButton({ run }: { run: FocusableRun }) {
  if (!run.herdrPane || !run.herdrName) return <>—</>;
  // key por Run: si la fila pasa a otro Run, el error y el estado pendiente no se heredan.
  return <FocusButton key={run.id} runId={run.id} pane={run.herdrPane} />;
}

function FocusButton({ runId, pane }: { runId: string; pane: string }) {
  const focus = useMutation({ mutationFn: () => api.focusRun(runId) });
  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        variant="outline"
        size="sm"
        className="font-mono"
        aria-label={`Enfocar pane ${pane} en herdr`}
        disabled={focus.isPending}
        onClick={() => focus.mutate()}
      >
        {pane}
      </Button>
      {focus.error && <MutationError error={focus.error} />}
    </div>
  );
}
