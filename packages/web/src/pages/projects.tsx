import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Loading, QueryError } from "../components/status.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.tsx";
import { queries } from "../lib/queries.ts";

export function ProjectsPage() {
  const projects = useQuery(queries.projects());
  if (projects.error) return <QueryError error={projects.error} />;
  if (!projects.data) return <Loading />;
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">Proyectos</h1>
      {projects.data.length === 0 && (
        <p className="text-sm text-muted-foreground">Todavía no hay proyectos registrados.</p>
      )}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {projects.data.map((project) => (
          <Card key={project.id}>
            <CardHeader>
              <CardTitle>
                <Link
                  to="/projects/$projectId"
                  params={{ projectId: project.id }}
                  className="hover:underline"
                >
                  {project.name}
                </Link>
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              <p>{project.repo}</p>
              <p>rama base: {project.baseBranch}</p>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
