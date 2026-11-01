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
  const focus = useMutation({ mutationFn: () => api.focusRun(run.id) });
  if (!run.herdrPane || !run.herdrName) return <>—</>;
  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        variant="outline"
        size="sm"
        className="font-mono"
        aria-label={`Enfocar pane ${run.herdrPane} en herdr`}
        disabled={focus.isPending}
        onClick={() => focus.mutate()}
      >
        {run.herdrPane}
      </Button>
      {focus.error && <MutationError error={focus.error} />}
    </div>
  );
}
