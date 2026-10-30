// Versiones de la spec, su contenido y el diff contra la anterior (ADR 0013). Aprobar o pedir
// cambios se puede desde aquí; la bandeja (UW-27) suma editar y aprobar.
import type { Spec, SpecApproval, SpecDiff, Task } from "@lunasq/schemas";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Json } from "../../lib/api.ts";
import { queries } from "../../lib/queries.ts";
import { Muted, Section } from "../section.tsx";
import { Loading, QueryError } from "../status.tsx";
import { Badge } from "../ui/badge.tsx";
import { Button } from "../ui/button.tsx";
import { Label, Textarea } from "../ui/input.tsx";

const APPROVAL_LABEL: Record<SpecApproval, string> = {
  pending: "pendiente",
  approved: "aprobada",
  changes_requested: "cambios pedidos",
};

function Content({ spec }: { spec: Json<Spec> }) {
  const { domainModel, requirements, criteria, taskList } = spec.content;
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p>
        <span className="font-medium">Bounded context:</span> {domainModel.boundedContext}
      </p>
      <div>
        <h3 className="font-medium">Requerimientos</h3>
        <ul className="list-disc pl-5">
          {requirements.map((r, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: los textos pueden repetirse y la lista no se reordena.
            <li key={i}>{r}</li>
          ))}
        </ul>
      </div>
      <div>
        <h3 className="font-medium">Criterios de aceptación</h3>
        <ul aria-label="Criterios de aceptación" className="flex flex-col gap-1">
          {criteria.map((c) => (
            <li key={c.id}>
              {`${c.id}: dado ${c.given}, cuando ${c.when}, entonces ${c.outcome}`}
            </li>
          ))}
        </ul>
      </div>
      <div>
        <h3 className="font-medium">Tareas</h3>
        <ul className="flex flex-col gap-1">
          {taskList.map((t) => (
            <li key={t.id}>{`${t.id}: ${t.title} (${t.criterionIds.join(", ")})`}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** Una línea por cambio: + agregado, − quitado, ~ modificado. */
function diffLines(diff: Json<SpecDiff>): string[] {
  const { domainModel: dm, requirements, criteria, taskList } = diff.changes;
  const lines: string[] = [];
  if (dm.boundedContext) {
    lines.push(`~ bounded context: ${dm.boundedContext.from} → ${dm.boundedContext.to}`);
  }
  const keyed = <T,>(
    label: string,
    d: { added: T[]; removed: T[]; changed: { key: string }[] },
    key: (item: T) => string,
  ) => {
    for (const item of d.added) lines.push(`+ ${label} ${key(item)}`);
    for (const item of d.removed) lines.push(`− ${label} ${key(item)}`);
    for (const item of d.changed) lines.push(`~ ${label} ${item.key}`);
  };
  const text = (label: string, d: { added: string[]; removed: string[] }) => {
    for (const item of d.added) lines.push(`+ ${label}: ${item}`);
    for (const item of d.removed) lines.push(`− ${label}: ${item}`);
  };
  keyed("criterio", criteria, (c) => c.id);
  text("requerimiento", requirements);
  keyed("tarea", taskList, (t) => t.id);
  keyed("término", dm.glossary, (g) => g.term);
  keyed("agregado", dm.aggregates, (a) => a.name);
  text("invariante", dm.invariants);
  keyed("evento", dm.events, (e) => e.name);
  return lines;
}

function Diff({ taskId, version }: { taskId: string; version: number }) {
  const diff = useQuery(queries.specDiff(taskId, version));
  if (diff.error) return <QueryError error={diff.error} />;
  if (!diff.data) return null;
  if (diff.data.from === null) return <Muted>Primera versión</Muted>;
  const lines = diffLines(diff.data);
  return (
    <div className="flex flex-col gap-1 text-sm">
      <h3 className="font-medium">{`Cambios contra v${diff.data.from}`}</h3>
      {diff.data.identical || lines.length === 0 ? (
        <Muted>Sin cambios.</Muted>
      ) : (
        <ul className="font-mono text-xs">
          {lines.map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: las líneas pueden repetirse y la lista no se reordena.
            <li key={i}>{line}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Review({ task, spec }: { task: Json<Task>; spec: Json<Spec> }) {
  const queryClient = useQueryClient();
  const [comments, setComments] = useState("");
  const onSuccess = async () => {
    setComments("");
    await queryClient.invalidateQueries({ queryKey: ["task", task.id] });
    await queryClient.invalidateQueries({ queryKey: ["queue"] });
    await queryClient.invalidateQueries({ queryKey: ["tasks"] });
  };
  const approve = useMutation({
    mutationFn: () => api.approveSpec(task.id, spec.version),
    onSuccess,
  });
  const requestChanges = useMutation({
    mutationFn: () => api.requestChanges(task.id, spec.version, comments.trim()),
    onSuccess,
  });
  const pending = approve.isPending || requestChanges.isPending;
  const error = approve.error ?? requestChanges.error;
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-3">
      <Button onClick={() => approve.mutate()} disabled={pending} className="self-start">
        {`Aprobar v${spec.version}`}
      </Button>
      <Label htmlFor={`comments-${spec.id}`}>Comentarios</Label>
      <Textarea
        id={`comments-${spec.id}`}
        value={comments}
        onChange={(e) => setComments(e.target.value)}
        placeholder="Qué debe cambiar el refinador"
      />
      <Button
        variant="outline"
        className="self-start"
        disabled={pending || comments.trim() === ""}
        onClick={() => requestChanges.mutate()}
      >
        Pedir cambios
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error.message}
        </p>
      )}
    </div>
  );
}

export function SpecPanel({ task }: { task: Json<Task> }) {
  const specs = useQuery(queries.specs(task.id));
  // La elección vale contra la última versión que había: si llega otra, se muestra la nueva para
  // que el gate (que solo aplica a la última) no quede oculto.
  const [choice, setChoice] = useState<{ version: number; latest: number } | null>(null);

  if (specs.error) {
    return (
      <Section title="Spec">
        <QueryError error={specs.error} />
      </Section>
    );
  }
  const versions = specs.data ?? [];
  const latest = versions.at(-1);
  const chosen =
    choice && choice.latest === latest?.version
      ? versions.find((s) => s.version === choice.version)
      : undefined;
  const spec = chosen ?? latest;
  return (
    <Section title="Spec">
      {specs.isPending ? (
        <Loading />
      ) : !spec || !latest ? (
        <Muted>El refinamiento todavía no entrega una spec.</Muted>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            {versions.map((s) => (
              <Button
                key={s.id}
                size="sm"
                variant={s.version === spec.version ? "default" : "outline"}
                aria-pressed={s.version === spec.version}
                onClick={() => setChoice({ version: s.version, latest: latest.version })}
              >
                {`v${s.version}`}
              </Button>
            ))}
            <Badge variant={spec.approval === "approved" ? "default" : "outline"}>
              {APPROVAL_LABEL[spec.approval]}
            </Badge>
            <span className="text-xs text-muted-foreground">{`autor: ${spec.createdBy}`}</span>
          </div>
          {spec.reviewComments && (
            <p className="text-sm">{`Comentarios de revisión: ${spec.reviewComments}`}</p>
          )}
          <Content spec={spec} />
          <Diff taskId={task.id} version={spec.version} />
          {task.state === "refined" &&
            spec.approval === "pending" &&
            spec.version === latest.version && <Review task={task} spec={spec} />}
        </div>
      )}
    </Section>
  );
}
