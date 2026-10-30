// Confirmación de borrado. El servidor rechaza con 409 `has_tasks` un proyecto con tareas.

import type { Project } from "@lunasq/schemas";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type Json } from "../lib/api.ts";
import { Button } from "./ui/button.tsx";
import { Dialog } from "./ui/dialog.tsx";

export function ProjectDeleteDialog({
  project,
  onClose,
}: {
  project: Json<Project>;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => api.deleteProject(project.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      onClose();
    },
  });

  return (
    <Dialog title="Eliminar proyecto" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <p className="text-sm">
          ¿Eliminar <strong>{project.name}</strong>? Esta acción no se puede deshacer.
        </p>
        {remove.error && (
          <p role="alert" className="text-sm text-destructive">
            No se pudo eliminar el proyecto: {remove.error.message}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate()}>
            Eliminar
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
