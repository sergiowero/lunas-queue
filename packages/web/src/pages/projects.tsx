import { type Project, unassignedPhases } from "@lunasq/schemas";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { PlusIcon } from "../components/icons.tsx";
import { PageHeader } from "../components/page-header.tsx";
import { ProjectDeleteDialog } from "../components/project-delete-dialog.tsx";
import { ProjectFormDialog } from "../components/project-form-dialog.tsx";
import { ProjectLabel } from "../components/project-label.tsx";
import { EmptyState, Loading, QueryError } from "../components/status.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.tsx";
import type { Json } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { queries } from "../lib/queries.ts";

const route = getRouteApi("/projects");

export function ProjectsPage() {
  const t = useT();
  const projects = useQuery(queries.projects());
  const search = route.useSearch();
  const navigate = useNavigate({ from: "/projects" });
  const [dialog, setDialog] = useState<
    { kind: "create" } | { kind: "edit" | "delete"; project: Json<Project> } | null
  >(null);
  // `?edit=<projectId>` (the held-task notice links here) opens that project's form once.
  const editId = search.edit;
  const editTarget = editId ? projects.data?.find((p) => p.id === editId) : undefined;
  useEffect(() => {
    if (!editTarget) return;
    setDialog({ kind: "edit", project: editTarget });
    void navigate({ search: {}, replace: true });
  }, [editTarget, navigate]);
  if (projects.error) return <QueryError error={projects.error} />;
  if (!projects.data) return <Loading />;
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={t.projectsPage.title}>
        <Button onClick={() => setDialog({ kind: "create" })}>
          <PlusIcon />
          {t.projectsPage.new}
        </Button>
      </PageHeader>
      {projects.data.length === 0 && <EmptyState>{t.projectsPage.empty}</EmptyState>}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {projects.data.map((project) => (
          <Card key={project.id} className="card-interactive flex flex-col">
            <CardHeader>
              <CardTitle>
                <Link
                  to="/projects/$projectId"
                  params={{ projectId: project.id }}
                  className="group"
                >
                  <ProjectLabel name={project.name} icon={project.icon} color={project.color} />
                </Link>
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-1 flex-col gap-1 text-sm text-muted-foreground">
              <p className="truncate font-mono text-[13px] text-text-secondary">{project.repo}</p>
              <p>
                {t.projectsPage.baseBranch}{" "}
                <span className="font-mono text-[13px] text-text-secondary">
                  {project.baseBranch}
                </span>
              </p>
              {unassignedPhases(project.agentProfiles).length > 0 && (
                <Badge variant="destructive" className="mt-2 max-w-full whitespace-normal">
                  {t.projectsPage.missingProfile(
                    unassignedPhases(project.agentProfiles)
                      .map((phase) => t.phase[phase])
                      .join(", "),
                  )}
                </Badge>
              )}
              <div className="mt-auto flex gap-2 border-t border-border-light pt-3">
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
                  className="hover:border-danger/40 hover:bg-danger/[0.06] hover:text-danger-text"
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
