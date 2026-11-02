// Spec versions, their content and the diff against the previous one (ADR 0013), with the gate: approve,
// request changes or edit and approve. Only the task detail mounts it: the inbox links to it (ADR 0015).
import type { Spec, SpecContent, SpecDiff, Task } from "@lunasq/schemas";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Json } from "../../lib/api.ts";
import type { Dictionary } from "../../lib/dictionary/index.ts";
import { useT } from "../../lib/i18n.ts";
import { queries } from "../../lib/queries.ts";
import { Muted, Section } from "../section.tsx";
import { Loading, MutationError, QueryError } from "../status.tsx";
import { Badge } from "../ui/badge.tsx";
import { Button } from "../ui/button.tsx";
import { Label, Textarea } from "../ui/input.tsx";

function Content({ spec }: { spec: Json<Spec> }) {
  const t = useT();
  const { domainModel, requirements, criteria, taskList } = spec.content;
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p>
        <span className="font-medium">{t.spec.boundedContext}</span> {domainModel.boundedContext}
      </p>
      <div>
        <h3 className="font-medium">{t.spec.requirements}</h3>
        <ul className="list-disc pl-5">
          {requirements.map((r, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the texts can repeat and the list is not reordered.
            <li key={i}>{r}</li>
          ))}
        </ul>
      </div>
      <div>
        <h3 className="font-medium">{t.spec.criteria}</h3>
        <ul aria-label={t.spec.criteria} className="flex flex-col gap-1">
          {criteria.map((c) => (
            <li key={c.id}>{t.spec.criterion(c.id, c.given, c.when, c.outcome)}</li>
          ))}
        </ul>
      </div>
      <div>
        <h3 className="font-medium">{t.spec.tasks}</h3>
        <ul className="flex flex-col gap-1">
          {taskList.map((item) => (
            <li key={item.id}>{`${item.id}: ${item.title} (${item.criterionIds.join(", ")})`}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** One line per change: + added, − removed, ~ modified. */
function diffLines(diff: Json<SpecDiff>, t: Dictionary): string[] {
  const { domainModel: dm, requirements, criteria, taskList } = diff.changes;
  const lines: string[] = [];
  if (dm.boundedContext) {
    lines.push(
      `~ ${t.spec.diffBoundedContext}: ${dm.boundedContext.from} → ${dm.boundedContext.to}`,
    );
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
  keyed(t.spec.diffLabels.criterion, criteria, (c) => c.id);
  text(t.spec.diffLabels.requirement, requirements);
  keyed(t.spec.diffLabels.task, taskList, (item) => item.id);
  keyed(t.spec.diffLabels.term, dm.glossary, (g) => g.term);
  keyed(t.spec.diffLabels.aggregate, dm.aggregates, (a) => a.name);
  text(t.spec.diffLabels.invariant, dm.invariants);
  keyed(t.spec.diffLabels.event, dm.events, (e) => e.name);
  return lines;
}

function Diff({ taskId, version }: { taskId: string; version: number }) {
  const t = useT();
  const diff = useQuery(queries.specDiff(taskId, version));
  if (diff.error) return <QueryError error={diff.error} />;
  if (!diff.data) return null;
  if (diff.data.from === null) return <Muted>{t.spec.firstVersion}</Muted>;
  const lines = diffLines(diff.data, t);
  return (
    <div className="flex flex-col gap-1 text-sm">
      <h3 className="font-medium">{t.spec.changesAgainst(diff.data.from)}</h3>
      {diff.data.identical || lines.length === 0 ? (
        <Muted>{t.spec.noChanges}</Muted>
      ) : (
        <ul className="font-mono text-xs">
          {lines.map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the lines can repeat and the list is not reordered.
            <li key={i}>{line}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Edit and approve (§Spec approval): the content goes as JSON and the server validates it. */
function Editor({
  spec,
  pending,
  onSave,
  onCancel,
}: {
  spec: Json<Spec>;
  pending: boolean;
  onSave: (content: SpecContent) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [text, setText] = useState(() => JSON.stringify(spec.content, null, 2));
  const [parseError, setParseError] = useState<string | null>(null);
  const save = () => {
    try {
      const content = JSON.parse(text) as SpecContent;
      setParseError(null);
      onSave(content);
    } catch (error) {
      setParseError(t.spec.invalidJson(error instanceof Error ? error.message : String(error)));
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={`content-${spec.id}`}>{t.spec.editorLabel}</Label>
      <Textarea
        id={`content-${spec.id}`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        className="min-h-80 font-mono text-xs"
      />
      <div className="flex gap-2">
        <Button onClick={save} disabled={pending}>
          {t.spec.saveAndApprove}
        </Button>
        <Button variant="outline" onClick={onCancel} disabled={pending}>
          {t.spec.cancelEdit}
        </Button>
      </div>
      {parseError && (
        <p role="alert" className="text-sm text-destructive">
          {parseError}
        </p>
      )}
    </div>
  );
}

function Review({ task, spec }: { task: Json<Task>; spec: Json<Spec> }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [comments, setComments] = useState("");
  const [editing, setEditing] = useState(false);
  const onSuccess = async () => {
    setComments("");
    setEditing(false);
    await queryClient.invalidateQueries({ queryKey: ["task", task.id] });
    await queryClient.invalidateQueries({ queryKey: ["queue"] });
    await queryClient.invalidateQueries({ queryKey: ["tasks"] });
  };
  // Only the last action's error is shown: each one clears the others'. A 409 does not
  // refresh the panel: it would unmount the gate with the error; the change that caused it arrives by SSE.
  const approve = useMutation({
    mutationFn: () => api.approveSpec(task.id, spec.version),
    onMutate: () => {
      requestChanges.reset();
      editAndApprove.reset();
    },
    onSuccess,
  });
  const requestChanges = useMutation({
    mutationFn: () => api.requestChanges(task.id, spec.version, comments.trim()),
    onMutate: () => {
      approve.reset();
      editAndApprove.reset();
    },
    onSuccess,
  });
  const editAndApprove = useMutation({
    mutationFn: (content: SpecContent) => api.editAndApprove(task.id, spec.version, content),
    onMutate: () => {
      approve.reset();
      requestChanges.reset();
    },
    onSuccess,
  });
  const pending = approve.isPending || requestChanges.isPending || editAndApprove.isPending;
  const error = approve.error ?? requestChanges.error ?? editAndApprove.error;
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-3">
      {editing ? (
        <Editor
          spec={spec}
          pending={pending}
          onSave={(content) => editAndApprove.mutate(content)}
          onCancel={() => {
            editAndApprove.reset();
            setEditing(false);
          }}
        />
      ) : (
        <>
          <div className="flex gap-2">
            <Button onClick={() => approve.mutate()} disabled={pending}>
              {t.spec.approve(spec.version)}
            </Button>
            <Button variant="outline" onClick={() => setEditing(true)} disabled={pending}>
              {t.spec.editAndApprove}
            </Button>
          </div>
          <Label htmlFor={`comments-${spec.id}`}>{t.spec.comments}</Label>
          <Textarea
            id={`comments-${spec.id}`}
            value={comments}
            onChange={(e) => setComments(e.target.value)}
            placeholder={t.spec.commentsPlaceholder}
          />
          <Button
            variant="outline"
            className="self-start"
            disabled={pending || comments.trim() === ""}
            onClick={() => requestChanges.mutate()}
          >
            {t.spec.requestChanges}
          </Button>
        </>
      )}
      {error && <MutationError error={error} />}
    </div>
  );
}

/** Versions, content, diff and gate; without a frame. */
export function SpecVersions({ task }: { task: Json<Task> }) {
  const t = useT();
  const specs = useQuery(queries.specs(task.id));
  // The choice holds against the last version there was: if another arrives, the new one is shown so
  // the gate (which only applies to the last one) is not hidden.
  const [choice, setChoice] = useState<{ version: number; latest: number } | null>(null);

  if (specs.error) return <QueryError error={specs.error} />;
  if (specs.isPending) return <Loading />;
  const versions = specs.data;
  const latest = versions.at(-1);
  const chosen =
    choice && choice.latest === latest?.version
      ? versions.find((s) => s.version === choice.version)
      : undefined;
  const spec = chosen ?? latest;
  if (!spec || !latest) return <Muted>{t.spec.notDelivered}</Muted>;
  return (
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
          {t.spec.approval[spec.approval]}
        </Badge>
        <span className="text-xs text-muted-foreground">{t.spec.author(spec.createdBy)}</span>
      </div>
      {spec.reviewComments && (
        <p className="text-sm">{t.spec.reviewComments(spec.reviewComments)}</p>
      )}
      <Content spec={spec} />
      <Diff taskId={task.id} version={spec.version} />
      {task.state === "refined" &&
        spec.approval === "pending" &&
        spec.version === latest.version && <Review task={task} spec={spec} />}
    </div>
  );
}

export function SpecPanel({ task }: { task: Json<Task> }) {
  const t = useT();
  return (
    <Section title={t.spec.title}>
      <SpecVersions task={task} />
    </Section>
  );
}
