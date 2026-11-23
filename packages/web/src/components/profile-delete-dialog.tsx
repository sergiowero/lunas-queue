// Delete confirmation for an agent profile. The server rejects with 409 `profile_in_use` a profile
// that projects select, and lists those projects and phases.
import type { AgentProfile } from "@lunasq/schemas";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError, api, type Json } from "../lib/api.ts";
import { useErrorText } from "../lib/error-text.ts";
import { useT } from "../lib/i18n.ts";
import { Button } from "./ui/button.tsx";
import { Dialog } from "./ui/dialog.tsx";

type UsedBy = { id: string; name: string; phases: string[] };

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
  const projects = usedBy(remove.error);

  return (
    <Dialog title={t.profileDelete.title} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <p className="text-sm">
          {t.profileDelete.confirmPrefix}
          <strong>{profile.name}</strong>
          {t.profileDelete.confirmSuffix}
        </p>
        {remove.error && (
          <div role="alert" className="text-sm text-destructive">
            {projects ? (
              <>
                <p>{t.profileDelete.inUse}</p>
                <ul className="mt-1 list-disc pl-5">
                  {projects.map((project) => (
                    <li key={project.id}>
                      {t.profileDelete.usedBy(project.name, project.phases.join(", "))}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p>{t.profileDelete.failed(errorText(remove.error))}</p>
            )}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate()}>
            {t.common.delete}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
