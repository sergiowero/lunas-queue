// Inbox (docs/design.md §Agent questions and blocks, ADR uw-27-bandeja): everything that waits
// for the human in a single place. The specs to approve (tasks in refined) are just a list of
// links: the spec and its gate are reviewed in the task detail (ADR 0015); the questions are
// answered here; permission blocks are answered in herdr, and the inbox takes the view to the
// agent's pane.
import type { BlockedAgent, Question, QuestionDelivery, Task } from "@lunasq/schemas";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useId, useState } from "react";
import { AgentBadge } from "../components/agent-badge.tsx";
import { CopyButton } from "../components/copy-button.tsx";
import { PageHeader } from "../components/page-header.tsx";
import { ProjectLabel } from "../components/project-label.tsx";
import { Muted, Section } from "../components/section.tsx";
import { Loading, MutationError, QueryError, StateBadges } from "../components/status.tsx";
import { TaskNumber } from "../components/task-number.tsx";
import { Time } from "../components/time.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { Label, Textarea } from "../components/ui/input.tsx";
import { api, type Json } from "../lib/api.ts";
import { useDocumentTitle } from "../lib/document-title.ts";
import { cappedTaskLabel, fullLabelTitle } from "../lib/format.ts";
import { useT } from "../lib/i18n.ts";
import { type Inbox, type TasksById, useInbox } from "../lib/inbox.ts";
import { onModEnter } from "../lib/keyboard.ts";
import { invalidateInbox } from "../lib/live.ts";
import { queries } from "../lib/queries.ts";

/** Result of the last answer; shown in the section because the card can disappear. */
type Notice = { ok: true; delivery: QuestionDelivery } | { ok: false; error: Error };

/** Name of the task's project, if the project list has already loaded. */
function ProjectName({ task }: { task: Json<Task> | undefined }) {
  const projects = useQuery(queries.projects());
  const project = projects.data?.find((p) => p.id === task?.projectId);
  if (!project) return null;
  // Without a color the name keeps the muted text; with one, the project's token wins.
  return (
    <ProjectLabel
      name={project.name}
      icon={project.icon}
      color={project.color}
      className={project.color ? "text-xs" : "text-xs text-muted-foreground"}
    />
  );
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
      <Link
        id={id}
        to="/tasks/$taskId"
        params={{ taskId }}
        className="font-medium underline decoration-border-strong underline-offset-4 transition-colors hover:text-primary-text hover:decoration-current"
        title={task ? fullLabelTitle(task) : undefined}
      >
        {task ? cappedTaskLabel(task) : taskId}
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
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface-secondary/40 p-4 transition-colors hover:border-border-strong"
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
    <Section title={t.inbox.specsTitle} count={refined.length}>
      {tasks.error ? (
        <QueryError error={tasks.error} />
      ) : tasks.isPending ? (
        <Loading />
      ) : refined.length === 0 ? (
        <Muted>{t.inbox.specsEmpty}</Muted>
      ) : (
        <ul className="flex flex-col divide-y divide-border-light overflow-hidden rounded-lg border border-border">
          {refined.map((task) => (
            <li
              key={task.id}
              className="flex flex-wrap items-baseline gap-2 px-4 py-2.5 transition-colors hover:bg-surface-secondary/60"
            >
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
    <Section title={t.inbox.escalatedTitle} count={escalated.length}>
      {tasks.error ? (
        <QueryError error={tasks.error} />
      ) : tasks.isPending ? (
        <Loading />
      ) : escalated.length === 0 ? (
        <Muted>{t.inbox.escalatedEmpty}</Muted>
      ) : (
        <div className="flex flex-col gap-3">
          {escalated.map((task) => (
            <Item key={task.id} task={task} taskId={task.id}>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <StateBadges state={task.state} subState={task.subState} />
                <Time iso={task.updatedAt} format={t.inbox.since} />
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
  const submit = () => {
    if (!send.isPending && answer !== "") send.mutate();
  };
  return (
    <Item task={task} taskId={question.taskId}>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {phase && <Badge variant="outline">{t.phase[phase]}</Badge>}
        <Time iso={question.createdAt} format={t.inbox.asked} />
      </div>
      <p className="whitespace-pre-wrap text-[15px] leading-relaxed font-medium">
        {question.question}
      </p>
      {question.context && (
        <p className="whitespace-pre-wrap border-l-2 border-border-strong pl-3 text-sm text-muted-foreground">
          {question.context}
        </p>
      )}
      {options ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-[13px] font-medium">{t.inbox.answer}</legend>
          {options.map((option, index) => (
            <label
              key={option.label}
              className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border bg-surface px-3 py-2 text-sm transition-colors hover:border-border-strong has-[:checked]:border-primary/60 has-[:checked]:bg-primary/[0.06]"
            >
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
          <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border bg-surface px-3 py-2 text-sm transition-colors hover:border-border-strong has-[:checked]:border-primary/60 has-[:checked]:bg-primary/[0.06]">
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
              onKeyDown={onModEnter(submit)}
            />
          )}
        </fieldset>
      ) : (
        <>
          <Label htmlFor={field}>{t.inbox.answer}</Label>
          <Textarea
            id={field}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={onModEnter(submit)}
          />
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
    <Section title={t.inbox.questionsTitle} count={questions.data?.length}>
      <div className="flex flex-col gap-4">
        {notice?.ok && (
          <p role="status" className="notice-success">
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
  // The blocked agent's profile is the one of its Run (the same query as the task's Runs panel).
  const runs = useQuery(queries.runs(agent.taskId));
  const run = runs.data?.find((r) => r.id === agent.runId);
  const focus = useMutation({
    mutationFn: () => api.focusBlocked(agent.runId),
    // 404 not_blocked or 409 agent_gone: the list went stale, it is re-requested without waiting for the refresh.
    onError: () => queryClient.invalidateQueries({ queryKey: ["blocked"] }),
  });
  return (
    <Item task={task} taskId={agent.taskId}>
      <dl className="grid grid-cols-[max-content_1fr] items-center gap-x-6 gap-y-1.5 text-sm">
        <dt className="text-muted-foreground">{t.inbox.phase}</dt>
        <dd>{t.phase[agent.phase]}</dd>
        <dt className="text-muted-foreground">{t.inbox.agent}</dt>
        <dd className="flex flex-wrap items-center gap-2">
          <AgentBadge
            profileId={run?.profileId}
            kind={run?.agentKind ?? null}
            pending={runs.isPending}
            unavailable={runs.isError}
          />
          <span className="font-mono">{agent.agentName}</span>
        </dd>
        <dt className="text-muted-foreground">{t.inbox.pane}</dt>
        <dd className="font-mono">{agent.paneId}</dd>
        <dt className="text-muted-foreground">{t.inbox.blockedSince}</dt>
        <dd>
          <Time iso={agent.since} />
        </dd>
      </dl>
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => focus.mutate()} disabled={focus.isPending}>
          {t.inbox.openPane}
        </Button>
        <span className="inline-flex items-center">
          <code className="rounded-md border border-border bg-surface px-2 py-1 font-mono text-xs text-muted-foreground">{`herdr agent focus ${agent.agentName}`}</code>
          <CopyButton value={`herdr agent focus ${agent.agentName}`} label="herdr agent focus" />
        </span>
      </div>
      {focus.isSuccess && (
        <p role="status" className="notice-success">
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
    <Section title={t.inbox.blockedTitle} count={blocked.data?.length}>
      {blocked.error ? (
        <QueryError error={blocked.error} />
      ) : blocked.isPending ? (
        <Loading />
      ) : blocked.data.length === 0 ? (
        <Muted>{t.inbox.blockedEmpty}</Muted>
      ) : (
        <div className="flex flex-col gap-3">
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
  useDocumentTitle(t.inbox.title);
  const inbox = useInbox();
  // Only with the three queries successful: one that failed cannot be read as «nothing pending».
  const loaded = inbox.tasks.isSuccess && inbox.questions.isSuccess && inbox.blocked.isSuccess;
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={t.inbox.title}
        description={loaded && inbox.count === 0 ? t.inbox.nothing : undefined}
      />
      <SpecsSection refined={inbox.refined} tasks={inbox.tasks} />
      <EscalatedSection escalated={inbox.escalated} tasks={inbox.tasks} />
      <QuestionsSection questions={inbox.questions} tasks={inbox.byId} />
      <BlockedSection blocked={inbox.blocked} tasks={inbox.byId} />
    </div>
  );
}
