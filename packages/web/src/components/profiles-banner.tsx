// Global notice: a project with a phase that has no agent profile holds that phase's tasks in
// queued (docs/decisions/agent-profiles.md). It is shown on any page, with a link to Projects.
import { unassignedPhases } from "@lunasq/schemas";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useT } from "../lib/i18n.ts";
import { queries } from "../lib/queries.ts";
import { WarningIcon } from "./icons.tsx";

export function ProfilesBanner() {
  const t = useT();
  const projects = useQuery(queries.projects());
  const affected = (projects.data ?? []).filter(
    (p) => unassignedPhases(p.agentProfiles).length > 0,
  );
  if (affected.length === 0) return null;
  return (
    <div role="status" className="border-b border-warning/25 bg-warning/10 text-sm text-text">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2.5 sm:px-6">
        <WarningIcon />
        <strong>{t.profilesBanner.title}</strong>
        <span>{t.profilesBanner.body(affected.length)}</span>
        <Link
          to="/projects"
          className="font-medium underline underline-offset-2 hover:text-warning-text"
        >
          {t.profilesBanner.goToProjects}
        </Link>
      </div>
    </div>
  );
}
