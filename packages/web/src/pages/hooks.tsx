// Vista de hooks por proyecto (docs/design.md §Hooks por fase): lo que hay en lunasq/hooks/ de la
// rama base y las últimas ejecuciones por tarea. Solo lectura: los hooks se cambian por PR.
import type { HookExecutionView, HookPoint, HookView } from "@lunasq/schemas";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { type ExecutionsState, HookCard } from "../components/hooks/hook-card.tsx";
import { Muted, Section } from "../components/section.tsx";
import { Loading, QueryError } from "../components/status.tsx";
import type { Json } from "../lib/api.ts";
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
  /** Las del punto, o el estado de la consulta mientras no hay lista. */
  executions: Execution[] | "loading" | "failed";
}) {
  const known = new Set(hooks.map((h) => h.script));
  // Scripts que corrieron pero ya no están en la rama base (se borraron o renombraron).
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
  const { projectId } = route.useParams();
  const projects = useQuery(queries.projects());
  const hooks = useQuery(queries.projectHooks(projectId));
  const executions = useQuery(queries.hookExecutions(projectId));
  const project = projects.data?.find((p) => p.id === projectId);

  if (projects.error) return <QueryError error={projects.error} />;
  if (!projects.data) return <Loading />;
  if (!project) return <p className="text-sm">El proyecto no existe.</p>;

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
        <h1 className="text-xl font-semibold">Hooks · {project.name}</h1>
        <p className="text-sm text-muted-foreground">
          Tal como están en {project.baseBranch}
          {hooks.data && (
            <>
              {" "}
              (<code>{hooks.data.baseRef.slice(0, 7)}</code>)
            </>
          )}
          . Se cambian por PR en el repo.{" "}
          <Link to="/projects/$projectId" params={{ projectId }} className="underline">
            Volver al tablero
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
              lunasq/hooks/config inválido, se muestran los valores por defecto:{" "}
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
          {empty.length > 0 && <Muted>Sin hooks: {empty.map((p) => p.point).join(", ")}.</Muted>}
        </>
      )}
    </div>
  );
}
