// Delete confirmation. The server rejects with 409 `has_tasks` a project that has tasks.

import type { Project } from "@lunasq/schemas";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type Json } from "../lib/api.ts";
import { useErrorText } from "../lib/error-text.ts";
import { useT } from "../lib/i18n.ts";
import { Button } from "./ui/button.tsx";
import { Dialog } from "./ui/dialog.tsx";

export function ProjectDeleteDialog({
  project,
  onClose,
}: {
  project: Json<Project>;
  onClose: () => void;
}) {
  const t = useT();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => api.deleteProject(project.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      onClose();
    },
  });

  return (
    <Dialog title={t.projectDelete.title} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <p className="text-sm">
          {t.projectDelete.confirmPrefix}
          <strong>{project.name}</strong>
          {t.projectDelete.confirmSuffix}
        </p>
        {remove.error && (
          <p role="alert" className="text-sm text-destructive">
            {t.projectDelete.failed(errorText(remove.error))}
          </p>
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
