// Alta (ProjectCreate) y edición (ProjectUpdate) de proyectos, ADR 0008. La validación es la del
// servidor; aquí solo se muestran sus issues. Al crear, los campos vacíos no se envían para que
// apliquen los defaults del servidor; al editar se envía todo, porque PATCH reemplaza cada campo
// presente y `null` borra los comandos opcionales.
import type { Phase, Project, ProjectCreate, ProjectUpdate } from "@lunasq/schemas";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { ApiError, api, type Json } from "../lib/api.ts";
import { Button } from "./ui/button.tsx";
import { Dialog } from "./ui/dialog.tsx";
import { Input, Label, Textarea } from "./ui/input.tsx";

const PHASES: Phase[] = ["refine", "implement", "verify", "deliver"];

type PhaseFields = { model: string; args: string; timeout: string };

function describe(error: Error): string {
  if (error instanceof ApiError && error.issues.length > 0) {
    return error.issues.map((i) => `${i.path.join(".") || "(cuerpo)"}: ${i.message}`).join("; ");
  }
  return error.message;
}

/** Un argumento por línea, para no depender de comillas ni de espacios dentro de un argumento. */
function parseArgs(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

const optionalInt = (text: string) => (text.trim() === "" ? undefined : Number(text));

type FormValues = {
  name: string;
  repo: string;
  baseBranch: string;
  localPath: string;
  testCommand: string;
  bootstrap: string;
  concurrency: string;
  maxIterations: string;
  phases: Record<Phase, PhaseFields>;
};

function initialPhases(project?: Json<Project>): Record<Phase, PhaseFields> {
  const phases = {} as Record<Phase, PhaseFields>;
  for (const phase of PHASES) {
    const profile = project?.agentProfiles[phase];
    phases[phase] = {
      model: profile?.model ?? "",
      args: profile?.args.join("\n") ?? "",
      timeout: String(project?.limits.phaseTimeoutMinutes?.[phase] ?? ""),
    };
  }
  return phases;
}

function optionalCommand(key: "testCommand" | "bootstrap", text: string, editing: boolean) {
  if (text.trim() !== "") return { [key]: text.trim() };
  return editing ? { [key]: null } : {};
}

function buildInput(form: FormValues, editing: boolean): ProjectCreate | ProjectUpdate {
  const agentProfiles: NonNullable<ProjectCreate["agentProfiles"]> = {};
  const phaseTimeoutMinutes: Partial<Record<Phase, number>> = {};
  for (const phase of PHASES) {
    const { model, args, timeout } = form.phases[phase];
    if (editing || model.trim() !== "" || parseArgs(args).length > 0) {
      agentProfiles[phase] = {
        kind: "claude",
        ...(model.trim() !== "" && { model: model.trim() }),
        args: parseArgs(args),
      };
    }
    const minutes = optionalInt(timeout);
    if (minutes !== undefined) phaseTimeoutMinutes[phase] = minutes;
  }
  const concurrency = optionalInt(form.concurrency);
  const maxVerificationIterations = optionalInt(form.maxIterations);
  const limits = {
    ...(concurrency !== undefined && { concurrency }),
    ...(maxVerificationIterations !== undefined && { maxVerificationIterations }),
    ...(Object.keys(phaseTimeoutMinutes).length > 0 && { phaseTimeoutMinutes }),
  };
  return {
    name: form.name,
    repo: form.repo,
    baseBranch: form.baseBranch,
    localPath: form.localPath,
    ...optionalCommand("testCommand", form.testCommand, editing),
    ...optionalCommand("bootstrap", form.bootstrap, editing),
    ...(Object.keys(agentProfiles).length > 0 && { agentProfiles }),
    ...((editing || Object.keys(limits).length > 0) && { limits }),
  };
}

export function ProjectFormDialog({
  project,
  onClose,
}: {
  /** Con proyecto, el formulario edita; sin él, crea. */
  project?: Json<Project>;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(project?.name ?? "");
  const [repo, setRepo] = useState(project?.repo ?? "");
  const [baseBranch, setBaseBranch] = useState(project?.baseBranch ?? "main");
  const [localPath, setLocalPath] = useState(project?.localPath ?? "");
  const [testCommand, setTestCommand] = useState(project?.testCommand ?? "");
  const [bootstrap, setBootstrap] = useState(project?.bootstrap ?? "");
  const [concurrency, setConcurrency] = useState(String(project?.limits.concurrency ?? ""));
  const [maxIterations, setMaxIterations] = useState(
    String(project?.limits.maxVerificationIterations ?? ""),
  );
  const [phases, setPhases] = useState(() => initialPhases(project));

  const save = useMutation({
    mutationFn: (input: ProjectCreate | ProjectUpdate) =>
      project ? api.updateProject(project.id, input) : api.createProject(input as ProjectCreate),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      onClose();
    },
  });

  const setPhase = (phase: Phase, patch: Partial<PhaseFields>) =>
    setPhases((current) => ({ ...current, [phase]: { ...current[phase], ...patch } }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate(
      buildInput(
        {
          name,
          repo,
          baseBranch,
          localPath,
          testCommand,
          bootstrap,
          concurrency,
          maxIterations,
          phases,
        },
        project !== undefined,
      ),
    );
  };

  return (
    <Dialog title={project ? "Editar proyecto" : "Nuevo proyecto"} onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor="project-name">Nombre</Label>
          <Input
            id="project-name"
            required
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="flex gap-4">
          <div className="flex flex-1 flex-col gap-1">
            <Label htmlFor="project-repo">Repositorio</Label>
            <Input
              id="project-repo"
              required
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="owner/name"
            />
          </div>
          <div className="flex w-40 flex-col gap-1">
            <Label htmlFor="project-base-branch">Rama base</Label>
            <Input
              id="project-base-branch"
              required
              value={baseBranch}
              onChange={(e) => setBaseBranch(e.target.value)}
            />
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="project-local-path">Ruta local</Label>
          <Input
            id="project-local-path"
            required
            value={localPath}
            onChange={(e) => setLocalPath(e.target.value)}
            placeholder="/ruta/absoluta/al/repo"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="project-test-command">Comando de tests</Label>
          <Input
            id="project-test-command"
            value={testCommand}
            onChange={(e) => setTestCommand(e.target.value)}
            placeholder="pnpm test"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="project-bootstrap">Bootstrap del worktree</Label>
          <Input
            id="project-bootstrap"
            value={bootstrap}
            onChange={(e) => setBootstrap(e.target.value)}
            placeholder="pnpm install"
          />
        </div>

        <fieldset className="flex flex-col gap-3">
          <legend className="text-sm font-medium">Límites</legend>
          <div className="flex gap-4">
            <div className="flex flex-1 flex-col gap-1">
              <Label htmlFor="project-concurrency">Concurrencia</Label>
              <Input
                id="project-concurrency"
                type="number"
                min={1}
                step={1}
                value={concurrency}
                onChange={(e) => setConcurrency(e.target.value)}
                placeholder="solo el límite global"
              />
            </div>
            <div className="flex flex-1 flex-col gap-1">
              <Label htmlFor="project-max-iterations">Iteraciones de verificación</Label>
              <Input
                id="project-max-iterations"
                type="number"
                min={1}
                max={20}
                step={1}
                value={maxIterations}
                onChange={(e) => setMaxIterations(e.target.value)}
                placeholder="3"
              />
            </div>
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-3">
          <legend className="text-sm font-medium">Agente por fase (Claude Code)</legend>
          {PHASES.map((phase) => (
            <div key={phase} className="flex flex-col gap-2 rounded-md border border-border p-3">
              <h3 className="text-xs font-medium uppercase text-muted-foreground">{phase}</h3>
              <div className="flex gap-4">
                <div className="flex flex-1 flex-col gap-1">
                  <Label htmlFor={`project-model-${phase}`}>Modelo de {phase}</Label>
                  <Input
                    id={`project-model-${phase}`}
                    value={phases[phase].model}
                    onChange={(e) => setPhase(phase, { model: e.target.value })}
                  />
                </div>
                <div className="flex w-40 flex-col gap-1">
                  <Label htmlFor={`project-timeout-${phase}`}>Timeout de {phase} (min)</Label>
                  <Input
                    id={`project-timeout-${phase}`}
                    type="number"
                    min={1}
                    step={1}
                    value={phases[phase].timeout}
                    onChange={(e) => setPhase(phase, { timeout: e.target.value })}
                    placeholder="30"
                  />
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor={`project-args-${phase}`}>
                  Argumentos de CLI para Claude en {phase} (uno por línea)
                </Label>
                <p id={`project-args-help-${phase}`} className="text-xs text-muted-foreground">
                  Flags que LunasQ pasa al comando <code>claude</code> al arrancar esta fase, p. ej.{" "}
                  <code>--effort</code> y en la línea siguiente <code>high</code>. No escribas aquí
                  un prompt ni texto suelto: Claude lo toma como prompt inicial y el arranque falla
                  por timeout.
                </p>
                <Textarea
                  id={`project-args-${phase}`}
                  aria-describedby={`project-args-help-${phase}`}
                  rows={2}
                  value={phases[phase].args}
                  onChange={(e) => setPhase(phase, { args: e.target.value })}
                />
              </div>
            </div>
          ))}
        </fieldset>

        {save.error && (
          <p role="alert" className="text-sm text-destructive">
            No se pudo {project ? "guardar" : "crear"} el proyecto: {describe(save.error)}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={save.isPending}>
            {project ? "Guardar cambios" : "Crear proyecto"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
