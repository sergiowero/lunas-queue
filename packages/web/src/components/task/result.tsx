// Resultado de una tarea completada sin código (submit_result, ADR 0007): una investigación,
// un pedido que ya estaba implementado o uno sin resolución. Se muestra directo en el detalle.
import type { Task } from "@lunasq/schemas";
import type { Json } from "../../lib/api.ts";
import { RESULT_KIND_LABEL } from "../../lib/format.ts";
import { MarkdownText } from "../markdown-text.tsx";
import { Section } from "../section.tsx";
import { Badge } from "../ui/badge.tsx";

export function ResultPanel({ task }: { task: Json<Task> }) {
  if (!task.resultKind || task.result === null) return null;
  return (
    <Section title="Resultado">
      <div className="flex flex-col gap-3">
        <div>
          <Badge variant="outline">{RESULT_KIND_LABEL[task.resultKind]}</Badge>
        </div>
        <MarkdownText>{task.result}</MarkdownText>
      </div>
    </Section>
  );
}
