// Bandeja (docs/design.md §Preguntas del agente y bloqueos, ADR uw-27-bandeja): todo lo que espera
// al humano en un solo lugar. Las specs por aprobar (tareas en refined) se resuelven con el mismo
// gate del detalle; las preguntas se responden aquí; los bloqueos por permiso se responden en
// herdr, y la bandeja lleva la vista al pane del agente.
import type { BlockedAgent, Question, QuestionDelivery, Task } from "@lunasq/schemas";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useId, useState } from "react";
import { Muted, Section } from "../components/section.tsx";
import { Loading, MutationError, QueryError } from "../components/status.tsx";
import { SpecVersions } from "../components/task/spec.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { Label, Textarea } from "../components/ui/input.tsx";
import { api, type Json } from "../lib/api.ts";
import { formatDate, PHASE_LABEL } from "../lib/format.ts";
import { type Inbox, type TasksById, useInbox } from "../lib/inbox.ts";
import { invalidateInbox } from "../lib/live.ts";
import { queries } from "../lib/queries.ts";

const DELIVERY_TEXT: Record<QuestionDelivery, string> = {
  pane: "Respuesta enviada al agente en su pane.",
  new_run: "Respuesta enviada: irá a un agente nuevo.",
};

/** Un pendiente: tarjeta con nombre (la tarea) para lectores de pantalla y tests. */
function Item({
  task,
  taskId,
  children,
}: {
  task: Json<Task> | undefined;
  taskId: string;
  children: ReactNode;
}) {
  const id = useId();
  const projects = useQuery(queries.projects());
  const project = projects.data?.find((p) => p.id === task?.projectId);
  return (
    <article
      aria-labelledby={id}
      className="flex flex-col gap-3 rounded-md border border-border p-3"
    >
      <header className="flex flex-wrap items-baseline gap-2">
        <Link id={id} to="/tasks/$taskId" params={{ taskId }} className="font-medium underline">
          {task?.intent ?? taskId}
        </Link>
        {project && <span className="text-xs text-muted-foreground">{project.name}</span>}
      </header>
      {children}
    </article>
  );
}

function SpecsSection({ refined, pending }: { refined: Json<Task>[]; pending: boolean }) {
  return (
    <Section title="Specs por aprobar">
      {pending ? (
        <Loading />
      ) : refined.length === 0 ? (
        <Muted>Ninguna spec espera aprobación.</Muted>
      ) : (
        <div className="flex flex-col gap-4">
          {refined.map((task) => (
            <Item key={task.id} task={task} taskId={task.id}>
              <SpecVersions task={task} />
            </Item>
          ))}
        </div>
      )}
    </Section>
  );
}

function QuestionItem({
  question,
  task,
  onAnswered,
}: {
  question: Json<Question>;
  task: Json<Task> | undefined;
  onAnswered: (delivery: QuestionDelivery) => void;
}) {
  const queryClient = useQueryClient();
  const runs = useQuery(queries.runs(question.taskId));
  const phase = runs.data?.find((r) => r.id === question.runId)?.phase;
  const [answer, setAnswer] = useState("");
  const send = useMutation({
    mutationFn: () => api.answerQuestion(question.id, answer.trim()),
    onSuccess: async ({ delivery }) => {
      onAnswered(delivery);
      invalidateInbox(queryClient);
      await queryClient.invalidateQueries({ queryKey: ["task", question.taskId] });
      await queryClient.invalidateQueries({ queryKey: ["queue"] });
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
  const field = `answer-${question.id}`;
  return (
    <Item task={task} taskId={question.taskId}>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {phase && <Badge variant="outline">{PHASE_LABEL[phase]}</Badge>}
        <span>{`preguntó: ${formatDate(question.createdAt)}`}</span>
      </div>
      <p className="whitespace-pre-wrap text-sm font-medium">{question.question}</p>
      {question.context && (
        <p className="whitespace-pre-wrap text-sm text-muted-foreground">{question.context}</p>
      )}
      <Label htmlFor={field}>Respuesta</Label>
      <Textarea id={field} value={answer} onChange={(e) => setAnswer(e.target.value)} />
      <Button
        className="self-start"
        disabled={send.isPending || answer.trim() === ""}
        onClick={() => send.mutate()}
      >
        Responder
      </Button>
      {send.error && <MutationError error={send.error} />}
    </Item>
  );
}

function QuestionsSection({
  questions,
  tasks,
}: {
  questions: Inbox["questions"];
  tasks: TasksById;
}) {
  const [delivered, setDelivered] = useState<QuestionDelivery | null>(null);
  return (
    <Section title="Preguntas abiertas">
      <div className="flex flex-col gap-4">
        {delivered && (
          <p role="status" className="text-sm">
            {DELIVERY_TEXT[delivered]}
          </p>
        )}
        {questions.error ? (
          <QueryError error={questions.error} />
        ) : questions.isPending ? (
          <Loading />
        ) : questions.data.length === 0 ? (
          <Muted>Ningún agente espera una respuesta.</Muted>
        ) : (
          questions.data.map((q) => (
            <QuestionItem
              key={q.id}
              question={q}
              task={tasks.get(q.taskId)}
              onAnswered={setDelivered}
            />
          ))
        )}
      </div>
    </Section>
  );
}

function BlockedItem({ agent, task }: { agent: Json<BlockedAgent>; task: Json<Task> | undefined }) {
  const focus = useMutation({ mutationFn: () => api.focusBlocked(agent.runId) });
  return (
    <Item task={task} taskId={agent.taskId}>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Fase</dt>
        <dd>{PHASE_LABEL[agent.phase]}</dd>
        <dt className="text-muted-foreground">Agente</dt>
        <dd className="font-mono">{agent.agentName}</dd>
        <dt className="text-muted-foreground">Pane</dt>
        <dd className="font-mono">{agent.paneId}</dd>
        <dt className="text-muted-foreground">Bloqueado desde</dt>
        <dd>{formatDate(agent.since)}</dd>
      </dl>
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => focus.mutate()} disabled={focus.isPending}>
          Abrir pane en herdr
        </Button>
        <code className="text-xs text-muted-foreground">{`herdr agent focus ${agent.agentName}`}</code>
      </div>
      {focus.isSuccess && (
        <p role="status" className="text-sm">
          Pane enfocado en herdr: responde el permiso ahí.
        </p>
      )}
      {focus.error && <MutationError error={focus.error} />}
    </Item>
  );
}

function BlockedSection({ blocked, tasks }: { blocked: Inbox["blocked"]; tasks: TasksById }) {
  return (
    <Section title="Agentes bloqueados">
      {blocked.error ? (
        <QueryError error={blocked.error} />
      ) : blocked.isPending ? (
        <Loading />
      ) : blocked.data.length === 0 ? (
        <Muted>Ningún agente espera un permiso.</Muted>
      ) : (
        <div className="flex flex-col gap-4">
          {blocked.data.map((b) => (
            <BlockedItem key={b.runId} agent={b} task={tasks.get(b.taskId)} />
          ))}
        </div>
      )}
    </Section>
  );
}

export function InboxPage() {
  const inbox = useInbox();
  const loaded = !inbox.tasks.isPending && !inbox.questions.isPending && !inbox.blocked.isPending;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline gap-3">
        <h1 className="text-xl font-semibold">Bandeja</h1>
        {loaded && inbox.count === 0 && <Muted>Nada espera por ti.</Muted>}
      </div>
      {inbox.tasks.error && <QueryError error={inbox.tasks.error} />}
      <SpecsSection refined={inbox.refined} pending={inbox.tasks.isPending} />
      <QuestionsSection questions={inbox.questions} tasks={inbox.byId} />
      <BlockedSection blocked={inbox.blocked} tasks={inbox.byId} />
    </div>
  );
}
