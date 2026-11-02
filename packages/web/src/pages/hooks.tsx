// Per-project hooks view (docs/design.md §Per-phase hooks): what is in the base branch's lunasq/hooks/
// and the latest executions per task. Read-only: hooks are changed by PR.
import type { HookExecutionView, HookPoint, HookView } from "@lunasq/schemas";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { type ExecutionsState, HookCard } from "../components/hooks/hook-card.tsx";
import { Muted, Section } from "../components/section.tsx";
import { Loading, QueryError } from "../components/status.tsx";
import type { Json } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { queries } from "../lib/queries.ts";

const route = getRouteApi("/projects/$projectId/hooks");

type Execution = Json<HookExecutionView>;

function PointSection({
  point,
  hooks,
  executions,
}: {
  point: HookPoint;
  hooks: Json<HookView>[];
  /** The point's, or the query state while there is no list. */
  executions: Execution[] | "loading" | "failed";
}) {
  const known = new Set(hooks.map((h) => h.script));
  // Scripts that ran but are no longer in the base branch (deleted or renamed).
  const list = Array.isArray(executions) ? executions : [];
  const forScript = (script: string): ExecutionsState =>
    Array.isArray(executions) ? list.filter((e) => e.script === script) : executions;
  const removed = [...new Set(list.map((e) => e.script))].filter((s) => !known.has(s));
  return (
    <Section title={point}>
      <div className="flex flex-col gap-3">
        {hooks.map((hook) => (
          <HookCard
            key={hook.script}
            script={hook.script}
            hook={hook}
            executions={forScript(hook.script)}
          />
        ))}
        {removed.map((script) => (
          <HookCard key={script} script={script} hook={null} executions={forScript(script)} />
        ))}
      </div>
    </Section>
  );
}

export function HooksPage() {
  const t = useT();
  const { projectId } = route.useParams();
  const projects = useQuery(queries.projects());
  const hooks = useQuery(queries.projectHooks(projectId));
  const executions = useQuery(queries.hookExecutions(projectId));
  const project = projects.data?.find((p) => p.id === projectId);

  if (projects.error) return <QueryError error={projects.error} />;
  if (!projects.data) return <Loading />;
  if (!project) return <p className="text-sm">{t.board.notFound}</p>;

  const executionsOf = (point: HookPoint): Execution[] | "loading" | "failed" =>
    executions.data
      ? executions.data.filter((e) => e.point === point)
      : executions.error
        ? "failed"
        : "loading";
  const points = hooks.data?.points ?? [];
  const hasExecutions = (point: HookPoint) => {
    const list = executionsOf(point);
    return Array.isArray(list) && list.length > 0;
  };
  const visible = points.filter((p) => p.hooks.length > 0 || hasExecutions(p.point));
  const empty = points.filter((p) => !visible.includes(p));

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">{t.hooksPage.title(project.name)}</h1>
        <p className="text-sm text-muted-foreground">
          {t.hooksPage.asIn}
          {project.baseBranch}
          {hooks.data && (
            <>
              {" "}
              (<code>{hooks.data.baseRef.slice(0, 7)}</code>)
            </>
          )}
          {t.hooksPage.changedByPr}
          <Link to="/projects/$projectId" params={{ projectId }} className="underline">
            {t.hooksPage.backToBoard}
          </Link>
        </p>
      </div>
      {hooks.error ? (
        <QueryError error={hooks.error} />
      ) : !hooks.data ? (
        <Loading />
      ) : (
        <>
          {hooks.data.configError && (
            <p role="alert" className="text-sm text-destructive">
              {t.hooksPage.invalidConfig}
              {hooks.data.configError}
            </p>
          )}
          {executions.error && <QueryError error={executions.error} />}
          {visible.map(({ point, hooks: pointHooks }) => (
            <PointSection
              key={point}
              point={point}
              hooks={pointHooks}
              executions={executionsOf(point)}
            />
          ))}
          {empty.length > 0 && (
            <Muted>{t.hooksPage.noHooks(empty.map((p) => p.point).join(", "))}</Muted>
          )}
        </>
      )}
    </div>
  );
}
