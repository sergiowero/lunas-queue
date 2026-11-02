import type { Project } from "@lunasq/schemas";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { ProjectDeleteDialog } from "../components/project-delete-dialog.tsx";
import { ProjectFormDialog } from "../components/project-form-dialog.tsx";
import { Loading, QueryError } from "../components/status.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.tsx";
import type { Json } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { queries } from "../lib/queries.ts";

export function ProjectsPage() {
  const t = useT();
  const projects = useQuery(queries.projects());
  const [dialog, setDialog] = useState<
    { kind: "create" } | { kind: "edit" | "delete"; project: Json<Project> } | null
  >(null);
  if (projects.error) return <QueryError error={projects.error} />;
  if (!projects.data) return <Loading />;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t.projectsPage.title}</h1>
        <Button onClick={() => setDialog({ kind: "create" })}>{t.projectsPage.new}</Button>
      </div>
      {projects.data.length === 0 && (
        <p className="text-sm text-muted-foreground">{t.projectsPage.empty}</p>
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
              <p>
                {t.projectsPage.baseBranch} {project.baseBranch}
              </p>
              <div className="mt-3 flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={t.projectsPage.editAria(project.name)}
                  onClick={() => setDialog({ kind: "edit", project })}
                >
                  {t.projectsPage.edit}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={t.projectsPage.deleteAria(project.name)}
                  onClick={() => setDialog({ kind: "delete", project })}
                >
                  {t.projectsPage.delete}
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      {dialog?.kind === "create" && <ProjectFormDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === "edit" && (
        <ProjectFormDialog project={dialog.project} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "delete" && (
        <ProjectDeleteDialog project={dialog.project} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}
