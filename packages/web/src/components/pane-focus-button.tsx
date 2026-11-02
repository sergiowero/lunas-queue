// A Run's pane id as a button that focuses it in herdr (ADR runs-foco-pane). Shared by the Runs
// panel and the In progress tab. A Run without a pane or agent name cannot be focused and the
// cell keeps showing «—» as text.

import type { RunView } from "@lunasq/schemas";
import { useMutation } from "@tanstack/react-query";
import { api, type Json } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { MutationError } from "./status.tsx";
import { Button } from "./ui/button.tsx";

type FocusableRun = Pick<Json<RunView>, "id" | "herdrPane" | "herdrName">;

export function PaneFocusButton({ run }: { run: FocusableRun }) {
  if (!run.herdrPane || !run.herdrName) return <>—</>;
  // key per Run: if the row moves to another Run, the error and the pending state are not inherited.
  return <FocusButton key={run.id} runId={run.id} pane={run.herdrPane} />;
}

function FocusButton({ runId, pane }: { runId: string; pane: string }) {
  const t = useT();
  const focus = useMutation({ mutationFn: () => api.focusRun(runId) });
  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        variant="outline"
        size="sm"
        className="font-mono"
        aria-label={t.paneFocus.aria(pane)}
        disabled={focus.isPending}
        onClick={() => focus.mutate()}
      >
        {pane}
      </Button>
      {focus.error && <MutationError error={focus.error} />}
    </div>
  );
}
