// Creation (ProjectCreate) and editing (ProjectUpdate) of projects, ADR 0008. Validation is the
// server's; here only its issues are shown. On create, empty fields are not sent so that
// the server defaults apply; on edit everything is sent, because PATCH replaces each present
// field and `null` clears the optional commands.
import {
  type AgentKind,
  EFFORT_LEVELS,
  type EffortLevel,
  type Phase,
  type Project,
  type ProjectCreate,
  type ProjectUpdate,
} from "@lunasq/schemas";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { ApiError, api, type Json } from "../lib/api.ts";
import type { Dictionary } from "../lib/dictionary/index.ts";
import { errorText } from "../lib/error-text.ts";
import { useT } from "../lib/i18n.ts";
import { Button } from "./ui/button.tsx";
import { Dialog } from "./ui/dialog.tsx";
import { Input, Label, Select, Textarea } from "./ui/input.tsx";

const PHASES: Phase[] = ["refine", "implement", "verify", "deliver"];

type PhaseFields = {
  kind: AgentKind;
  model: string;
  effort: string;
  args: string;
  timeout: string;
};

function describe(error: Error, t: Dictionary): string {
  if (error instanceof ApiError && error.issues.length > 0) {
    return error.issues.map((i) => `${i.path.join(".") || t.common.body}: ${i.message}`).join("; ");
  }
  return errorText(error, t);
}

/** One argument per line, so as not to depend on quotes or spaces inside an argument. */
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
      kind: profile?.kind ?? "claude",
      model: profile?.model ?? "",
      effort: profile?.effort ?? "",
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
    const { kind, model, effort, args, timeout } = form.phases[phase];
    if (
      editing ||
      kind !== "claude" ||
      model.trim() !== "" ||
      effort !== "" ||
      parseArgs(args).length > 0
    ) {
      agentProfiles[phase] = {
        kind,
        ...(model.trim() !== "" && { model: model.trim() }),
        ...(effort !== "" && { effort: effort as EffortLevel }),
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
  /** With a project, the form edits; without it, it creates. */
  project?: Json<Project>;
  onClose: () => void;
}) {
  const t = useT();
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
    <Dialog title={project ? t.projectForm.editTitle : t.projectForm.newTitle} onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor="project-name">{t.projectForm.name}</Label>
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
            <Label htmlFor="project-repo">{t.projectForm.repo}</Label>
            <Input
              id="project-repo"
              required
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="owner/name"
            />
          </div>
          <div className="flex w-40 flex-col gap-1">
            <Label htmlFor="project-base-branch">{t.projectForm.baseBranch}</Label>
            <Input
              id="project-base-branch"
              required
              value={baseBranch}
              onChange={(e) => setBaseBranch(e.target.value)}
            />
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="project-local-path">{t.projectForm.localPath}</Label>
          <Input
            id="project-local-path"
            required
            value={localPath}
            onChange={(e) => setLocalPath(e.target.value)}
            placeholder={t.projectForm.localPathPlaceholder}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="project-test-command">{t.projectForm.testCommand}</Label>
          <Input
            id="project-test-command"
            value={testCommand}
            onChange={(e) => setTestCommand(e.target.value)}
            placeholder="pnpm test"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="project-bootstrap">{t.projectForm.bootstrap}</Label>
          <Input
            id="project-bootstrap"
            value={bootstrap}
            onChange={(e) => setBootstrap(e.target.value)}
            placeholder="pnpm install"
          />
        </div>

        <fieldset className="flex flex-col gap-3">
          <legend className="text-sm font-medium">{t.projectForm.limits}</legend>
          <div className="flex gap-4">
            <div className="flex flex-1 flex-col gap-1">
              <Label htmlFor="project-concurrency">{t.projectForm.concurrency}</Label>
              <Input
                id="project-concurrency"
                type="number"
                min={1}
                step={1}
                value={concurrency}
                onChange={(e) => setConcurrency(e.target.value)}
                placeholder={t.projectForm.concurrencyPlaceholder}
              />
            </div>
            <div className="flex flex-1 flex-col gap-1">
              <Label htmlFor="project-max-iterations">{t.projectForm.maxIterations}</Label>
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
          <legend className="text-sm font-medium">{t.projectForm.agentByPhase}</legend>
          {PHASES.map((phase) => (
            <div key={phase} className="flex flex-col gap-2 rounded-md border border-border p-3">
              <h3 className="text-xs font-medium uppercase text-muted-foreground">{phase}</h3>
              <div className="flex flex-col gap-1">
                <Label htmlFor={`project-agent-${phase}`}>{t.projectForm.provider(phase)}</Label>
                <Select
                  id={`project-agent-${phase}`}
                  value={phases[phase].kind}
                  onChange={(e) =>
                    setPhase(phase, { kind: e.target.value === "copilot" ? "copilot" : "claude" })
                  }
                >
                  <option value="claude">Claude Code</option>
                  <option value="copilot">GitHub Copilot CLI</option>
                </Select>
              </div>
              <div className="flex gap-4">
                <div className="flex flex-1 flex-col gap-1">
                  <Label htmlFor={`project-model-${phase}`}>{t.projectForm.model(phase)}</Label>
                  <Input
                    id={`project-model-${phase}`}
                    value={phases[phase].model}
                    onChange={(e) => setPhase(phase, { model: e.target.value })}
                  />
                </div>
                <div className="flex w-40 flex-col gap-1">
                  <Label htmlFor={`project-effort-${phase}`}>{t.projectForm.effort(phase)}</Label>
                  <Select
                    id={`project-effort-${phase}`}
                    value={phases[phase].effort}
                    onChange={(e) => setPhase(phase, { effort: e.target.value })}
                  >
                    <option value="">{t.projectForm.effortDefault}</option>
                    {EFFORT_LEVELS.map((level) => (
                      <option key={level} value={level}>
                        {level}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="flex w-40 flex-col gap-1">
                  <Label htmlFor={`project-timeout-${phase}`}>{t.projectForm.timeout(phase)}</Label>
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
                  {t.projectForm.argsLabel(
                    phases[phase].kind === "claude" ? "Claude" : "Copilot",
                    phase,
                  )}
                </Label>
                <p id={`project-args-help-${phase}`} className="text-xs text-muted-foreground">
                  {t.projectForm.argsHelp.before}
                  <code>{phases[phase].kind === "claude" ? "claude" : "copilot"}</code>
                  {t.projectForm.argsHelp.after}
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
            {project
              ? t.projectForm.saveFailed(describe(save.error, t))
              : t.projectForm.createFailed(describe(save.error, t))}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button type="submit" disabled={save.isPending}>
            {project ? t.projectForm.saveChanges : t.projectForm.create}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
