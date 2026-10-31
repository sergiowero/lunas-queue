// Intent con sus menciones #N enlazadas al detalle de la tarea mencionada (ADR 0015). Solo para
// donde el intent no está ya dentro de un enlace: tarjetas y filas lo muestran como texto plano.
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { splitMentions } from "../../lib/mentions.ts";
import { queries } from "../../lib/queries.ts";

export function IntentText({ intent }: { intent: string }) {
  const parts = useMemo(() => splitMentions(intent), [intent]);
  const hasMentions = parts.some((part) => typeof part !== "string");
  // Sin menciones no hace falta resolver números: no se piden las tareas.
  const tasks = useQuery({ ...queries.tasks(), enabled: hasMentions });
  const byNumber = useMemo(
    () => new Map((tasks.data ?? []).map((task) => [task.number, task.id])),
    [tasks.data],
  );
  return parts.map((part, i) => {
    if (typeof part === "string") return part;
    const taskId = byNumber.get(part.number);
    if (!taskId) return part.text;
    return (
      // biome-ignore lint/suspicious/noArrayIndexKey: los trozos no cambian de orden.
      <Link key={i} to="/tasks/$taskId" params={{ taskId }} className="underline">
        {part.text}
      </Link>
    );
  });
}
