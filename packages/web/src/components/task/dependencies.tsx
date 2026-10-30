import type { DependencyLink } from "@lunasq/schemas";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { Json } from "../../lib/api.ts";
import { STATE_LABEL } from "../../lib/format.ts";
import { queries } from "../../lib/queries.ts";
import { Muted, Section } from "../section.tsx";
import { QueryError } from "../status.tsx";
import { TaskNumber } from "../task-number.tsx";
import { Badge } from "../ui/badge.tsx";

function Links({ title, links }: { title: string; links: Json<DependencyLink>[] }) {
  if (links.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-sm font-medium">{title}</h3>
      <ul className="flex flex-col gap-1 text-sm">
        {links.map((link) => (
          <li key={link.taskId} className="flex flex-wrap items-center gap-2">
            <TaskNumber number={link.number} />
            <Link to="/tasks/$taskId" params={{ taskId: link.taskId }} className="hover:underline">
              {link.intent}
            </Link>
            <Badge variant="secondary">{STATE_LABEL[link.state]}</Badge>
            {link.prState && <Badge variant="outline">PR {link.prState}</Badge>}
            {link.crossProject && <Badge variant="destructive">otro proyecto</Badge>}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function DependenciesPanel({ taskId }: { taskId: string }) {
  const deps = useQuery(queries.dependencies(taskId));
  return (
    <Section title="Dependencias">
      {deps.error ? (
        <QueryError error={deps.error} />
      ) : deps.data ? (
        deps.data.dependsOn.length + deps.data.dependents.length === 0 ? (
          <Muted>Sin dependencias.</Muted>
        ) : (
          <div className="flex flex-col gap-3">
            <Links title="Depende de" links={deps.data.dependsOn} />
            <Links title="La esperan" links={deps.data.dependents} />
          </div>
        )
      ) : null}
    </Section>
  );
}
