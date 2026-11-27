// Delete confirmation for an agent profile. The server rejects with 409 `profile_in_use` a profile
// that projects select, and lists those projects and phases.
import type { AgentProfile, Phase } from "@lunasq/schemas";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api, type Json } from "../lib/api.ts";
import { useErrorText } from "../lib/error-text.ts";
import { useT } from "../lib/i18n.ts";
import { queries } from "../lib/queries.ts";
import { Button } from "./ui/button.tsx";
import { Dialog } from "./ui/dialog.tsx";

const PHASES = ["refine", "implement", "verify", "deliver"] as const;

type UsedBy = { id: string; name: string; phases: Phase[] };

function usedBy(error: Error | null): UsedBy[] | null {
  if (!(error instanceof ApiError) || error.code !== "profile_in_use") return null;
  return Array.isArray(error.body.projects) ? (error.body.projects as UsedBy[]) : [];
}

export function ProfileDeleteDialog({
  profile,
  onClose,
}: {
  profile: Json<AgentProfile>;
  onClose: () => void;
}) {
  const t = useT();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => api.deleteAgentProfile(profile.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["agent-profiles"] });
      onClose();
    },
  });
  const allProjects = useQuery(queries.projects());
  // Known before trying: the projects that select the profile. The server's 409 stays as the guard.
  const known: UsedBy[] = (allProjects.data ?? [])
    .map((project) => ({
      id: project.id,
      name: project.name,
      phases: PHASES.filter((phase) => project.agentProfiles[phase] === profile.id),
    }))
    .filter((project) => project.phases.length > 0);
  const projects = usedBy(remove.error) ?? (known.length > 0 ? known : null);

  return (
    <Dialog title={t.profileDelete.title} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <p className="text-sm">
          {t.profileDelete.confirmPrefix}
          <strong>{profile.name}</strong>
          {t.profileDelete.confirmSuffix}
        </p>
        {(remove.error || projects) && (
          <div role="alert" className="alert-danger">
            {projects ? (
              <>
                <p>{t.profileDelete.inUse}</p>
                <ul className="mt-1 list-disc pl-5">
                  {projects.map((project) => (
                    <li key={project.id}>
                      {t.profileDelete.usedBy(
                        project.name,
                        project.phases.map((phase) => t.phase[phase] ?? phase).join(", "),
                      )}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p>{t.profileDelete.failed(errorText(remove.error as Error))}</p>
            )}
          </div>
        )}
        <div className="mt-1 flex justify-end gap-2 border-t border-border-light pt-4">
          <Button variant="outline" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button
            variant="destructive"
            disabled={remove.isPending || projects !== null}
            onClick={() => remove.mutate()}
          >
            {t.common.delete}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
