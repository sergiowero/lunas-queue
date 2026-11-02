// Resultado de una tarea completada sin código (submit_result, ADR 0007): una investigación,
// un pedido que ya estaba implementado o uno sin resolución. Se muestra directo en el detalle.
import type { Task } from "@lunasq/schemas";
import type { Json } from "../../lib/api.ts";
import { useT } from "../../lib/i18n.ts";
import { MarkdownText } from "../markdown-text.tsx";
import { Section } from "../section.tsx";
import { Badge } from "../ui/badge.tsx";

export function ResultPanel({ task }: { task: Json<Task> }) {
  const t = useT();
  if (!task.resultKind || task.result === null) return null;
  return (
    <Section title={t.result.title}>
      <div className="flex flex-col gap-3">
        <div>
          <Badge variant="outline">{t.resultKind[task.resultKind]}</Badge>
        </div>
        <MarkdownText>{task.result}</MarkdownText>
      </div>
    </Section>
  );
}
