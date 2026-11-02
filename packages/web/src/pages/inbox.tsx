// Inbox (docs/design.md §Agent questions and blocks, ADR uw-27-bandeja): everything that waits
// for the human in a single place. The specs to approve (tasks in refined) are just a list of
// links: the spec and its gate are reviewed in the task detail (ADR 0015); the questions are
// answered here; permission blocks are answered in herdr, and the inbox takes the view to the
// agent's pane.
import type { BlockedAgent, Question, QuestionDelivery, Task } from "@lunasq/schemas";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useId, useState } from "react";
import { Muted, Section } from "../components/section.tsx";
import { Loading, MutationError, QueryError, StateBadges } from "../components/status.tsx";
import { TaskNumber } from "../components/task-number.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { Label, Textarea } from "../components/ui/input.tsx";
import { api, type Json } from "../lib/api.ts";
import { formatDate, taskLabel } from "../lib/format.ts";
import { useT } from "../lib/i18n.ts";
import { type Inbox, type TasksById, useInbox } from "../lib/inbox.ts";
import { invalidateInbox } from "../lib/live.ts";
import { queries } from "../lib/queries.ts";

/** Result of the last answer; shown in the section because the card can disappear. */
type Notice = { ok: true; delivery: QuestionDelivery } | { ok: false; error: Error };

/** Name of the task's project, if the project list has already loaded. */
function ProjectName({ task }: { task: Json<Task> | undefined }) {
  const projects = useQuery(queries.projects());
  const project = projects.data?.find((p) => p.id === task?.projectId);
  return project ? <span className="text-xs text-muted-foreground">{project.name}</span> : null;
}

function TaskLink({
  id,
  task,
  taskId,
}: {
  id?: string;
  task: Json<Task> | undefined;
  taskId: string;
}) {
  return (
    <>
      {task && <TaskNumber number={task.number} />}
      <Link id={id} to="/tasks/$taskId" params={{ taskId }} className="font-medium underline">
        {task ? taskLabel(task) : taskId}
      </Link>
    </>
  );
}

/** A pending item: card with a name (the task) for screen readers and tests. */
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
  return (
    <article
      aria-labelledby={id}
      className="flex flex-col gap-3 rounded-md border border-border p-3"
    >
      <header className="flex flex-wrap items-baseline gap-2">
        <TaskLink id={id} task={task} taskId={taskId} />
        <ProjectName task={task} />
      </header>
      {children}
    </article>
  );
}

/** One row per task in refined: the spec and its gate live in the task detail. */
function SpecsSection({ refined, tasks }: { refined: Json<Task>[]; tasks: Inbox["tasks"] }) {
  const t = useT();
  return (
    <Section title={t.inbox.specsTitle}>
      {tasks.error ? (
        <QueryError error={tasks.error} />
      ) : tasks.isPending ? (
        <Loading />
      ) : refined.length === 0 ? (
        <Muted>{t.inbox.specsEmpty}</Muted>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
          {refined.map((task) => (
            <li key={task.id} className="flex flex-wrap items-baseline gap-2 px-3 py-2">
              <TaskLink task={task} taskId={task.id} />
              <ProjectName task={task} />
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function EscalatedSection({
  escalated,
  tasks,
}: {
  escalated: Json<Task>[];
  tasks: Inbox["tasks"];
}) {
  const t = useT();
  return (
    <Section title={t.inbox.escalatedTitle}>
      {tasks.error ? (
        <QueryError error={tasks.error} />
      ) : tasks.isPending ? (
        <Loading />
      ) : escalated.length === 0 ? (
        <Muted>{t.inbox.escalatedEmpty}</Muted>
      ) : (
        <div className="flex flex-col gap-4">
          {escalated.map((task) => (
            <Item key={task.id} task={task} taskId={task.id}>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <StateBadges state={task.state} subState={task.subState} />
                <span>{t.inbox.since(formatDate(task.updatedAt))}</span>
              </div>
            </Item>
          ))}
        </div>
      )}
    </Section>
  );
}

/** Value of `choice` for «Otra respuesta»: the human writes their own text. */
const OTHER = "other";

function QuestionItem({
  question,
  task,
  onResult,
}: {
  question: Json<Question>;
  task: Json<Task> | undefined;
  onResult: (notice: Notice | null) => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const runs = useQuery(queries.runs(question.taskId));
  const phase = runs.data?.find((r) => r.id === question.runId)?.phase;
  const [typed, setTyped] = useState("");
  // Index of the chosen option, OTHER for «Otra respuesta» and null while there is no choice.
  const [choice, setChoice] = useState<number | typeof OTHER | null>(null);
  const options = question.options;
  const answer = options
    ? choice === OTHER
      ? typed.trim()
      : choice === null
        ? ""
        : (options[choice]?.label ?? "")
    : typed.trim();
  const send = useMutation({
    mutationFn: () => api.answerQuestion(question.id, answer),
    onMutate: () => onResult(null),
    onSuccess: ({ delivery }) => onResult({ ok: true, delivery }),
    // A 409 (not_open, task_not_waiting) also changes the inbox: the question no longer waits.
    onError: (error) => onResult({ ok: false, error }),
    onSettled: async () => {
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
        {phase && <Badge variant="outline">{t.phase[phase]}</Badge>}
        <span>{t.inbox.asked(formatDate(question.createdAt))}</span>
      </div>
      <p className="whitespace-pre-wrap text-sm font-medium">{question.question}</p>
      {question.context && (
        <p className="whitespace-pre-wrap text-sm text-muted-foreground">{question.context}</p>
      )}
      {options ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-[13px] font-medium">{t.inbox.answer}</legend>
          {options.map((option, index) => (
            <label key={option.label} className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name={field}
                className="mt-1"
                checked={choice === index}
                onChange={() => setChoice(index)}
              />
              <span className="flex flex-col">
                <span>{option.label}</span>
                {option.description && (
                  <span className="text-muted-foreground">{option.description}</span>
                )}
              </span>
            </label>
          ))}
          <label className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name={field}
              className="mt-1"
              checked={choice === OTHER}
              onChange={() => setChoice(OTHER)}
            />
            <span>{t.inbox.otherAnswer}</span>
          </label>
          {choice === OTHER && (
            <Textarea
              aria-label={t.inbox.otherAnswer}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
            />
          )}
        </fieldset>
      ) : (
        <>
          <Label htmlFor={field}>{t.inbox.answer}</Label>
          <Textarea id={field} value={typed} onChange={(e) => setTyped(e.target.value)} />
        </>
      )}
      <Button
        className="self-start"
        disabled={send.isPending || answer === ""}
        onClick={() => send.mutate()}
      >
        {t.inbox.reply}
      </Button>
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
  const t = useT();
  const [notice, setNotice] = useState<Notice | null>(null);
  return (
    <Section title={t.inbox.questionsTitle}>
      <div className="flex flex-col gap-4">
        {notice?.ok && (
          <p role="status" className="text-sm">
            {t.inbox.delivery[notice.delivery]}
          </p>
        )}
        {notice && !notice.ok && <MutationError error={notice.error} />}
        {questions.error ? (
          <QueryError error={questions.error} />
        ) : questions.isPending ? (
          <Loading />
        ) : questions.data.length === 0 ? (
          <Muted>{t.inbox.questionsEmpty}</Muted>
        ) : (
          questions.data.map((q) => (
            <QuestionItem key={q.id} question={q} task={tasks.get(q.taskId)} onResult={setNotice} />
          ))
        )}
      </div>
    </Section>
  );
}

function BlockedItem({ agent, task }: { agent: Json<BlockedAgent>; task: Json<Task> | undefined }) {
  const t = useT();
  const queryClient = useQueryClient();
  const focus = useMutation({
    mutationFn: () => api.focusBlocked(agent.runId),
    // 404 not_blocked or 409 agent_gone: the list went stale, it is re-requested without waiting for the refresh.
    onError: () => queryClient.invalidateQueries({ queryKey: ["blocked"] }),
  });
  return (
    <Item task={task} taskId={agent.taskId}>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">{t.inbox.phase}</dt>
        <dd>{t.phase[agent.phase]}</dd>
        <dt className="text-muted-foreground">{t.inbox.agent}</dt>
        <dd className="font-mono">{agent.agentName}</dd>
        <dt className="text-muted-foreground">{t.inbox.pane}</dt>
        <dd className="font-mono">{agent.paneId}</dd>
        <dt className="text-muted-foreground">{t.inbox.blockedSince}</dt>
        <dd>{formatDate(agent.since)}</dd>
      </dl>
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => focus.mutate()} disabled={focus.isPending}>
          {t.inbox.openPane}
        </Button>
        <code className="text-xs text-muted-foreground">{`herdr agent focus ${agent.agentName}`}</code>
      </div>
      {focus.isSuccess && (
        <p role="status" className="text-sm">
          {t.inbox.paneFocused}
        </p>
      )}
      {focus.error && <MutationError error={focus.error} />}
    </Item>
  );
}

function BlockedSection({ blocked, tasks }: { blocked: Inbox["blocked"]; tasks: TasksById }) {
  const t = useT();
  return (
    <Section title={t.inbox.blockedTitle}>
      {blocked.error ? (
        <QueryError error={blocked.error} />
      ) : blocked.isPending ? (
        <Loading />
      ) : blocked.data.length === 0 ? (
        <Muted>{t.inbox.blockedEmpty}</Muted>
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
  const t = useT();
  const inbox = useInbox();
  // Only with the three queries successful: one that failed cannot be read as «nothing pending».
  const loaded = inbox.tasks.isSuccess && inbox.questions.isSuccess && inbox.blocked.isSuccess;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline gap-3">
        <h1 className="text-xl font-semibold">{t.inbox.title}</h1>
        {loaded && inbox.count === 0 && <Muted>{t.inbox.nothing}</Muted>}
      </div>
      <SpecsSection refined={inbox.refined} tasks={inbox.tasks} />
      <EscalatedSection escalated={inbox.escalated} tasks={inbox.tasks} />
      <QuestionsSection questions={inbox.questions} tasks={inbox.byId} />
      <BlockedSection blocked={inbox.blocked} tasks={inbox.byId} />
    </div>
  );
}
