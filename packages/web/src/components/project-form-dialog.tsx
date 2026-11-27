// Creation (ProjectCreate) and editing (ProjectUpdate) of projects, ADR 0008. Validation is the
// server's; here only its issues are shown. On create, empty fields are not sent so that
// the server defaults apply; on edit everything is sent, because PATCH replaces each present
// field and `null` clears the optional commands.
import type {
  AgentProfile,
  AgentProviderSettings,
  Phase,
  Project,
  ProjectColor,
  ProjectCreate,
  ProjectIcon,
  ProjectUpdate,
} from "@lunasq/schemas";
import { PROJECT_COLORS, PROJECT_ICONS } from "@lunasq/schemas";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { ApiError, api, type Json } from "../lib/api.ts";
import type { Dictionary } from "../lib/dictionary/index.ts";
import { errorText } from "../lib/error-text.ts";
import { useT } from "../lib/i18n.ts";
import { queries } from "../lib/queries.ts";
import { cn } from "../lib/utils.ts";
import { ProjectIconGlyph } from "./icons.tsx";
import { PROJECT_COLOR_SWATCH, ProjectLabel } from "./project-label.tsx";
import { Button } from "./ui/button.tsx";
import { Dialog } from "./ui/dialog.tsx";
import { Input, Label, Select } from "./ui/input.tsx";

const PICKER_OPTION = cn(
  "flex size-8 cursor-pointer items-center justify-center rounded-lg border border-border bg-surface transition-colors hover:border-border-strong",
  "has-[:checked]:border-primary has-[:checked]:bg-primary/10 has-[:checked]:ring-2 has-[:checked]:ring-primary/40",
  "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2",
);

const PHASES: Phase[] = ["refine", "implement", "verify", "deliver"];

type PhaseFields = {
  /** Selected agent profile id; "" leaves the phase unassigned. */
  profile: string;
  timeout: string;
};

/** Providers of the selected profile's models that are disabled in Settings (they are skipped). */
function disabledKinds(
  profiles: Json<AgentProfile>[] | undefined,
  providers: Json<AgentProviderSettings> | undefined,
  profileId: string,
): string[] {
  const profile = profiles?.find((p) => p.id === profileId);
  if (!profile || !providers) return [];
  return [...new Set(profile.models.map((m) => m.kind).filter((kind) => !providers[kind]))];
}

function describe(error: Error, t: Dictionary): string {
  if (error instanceof ApiError && error.issues.length > 0) {
    return error.issues.map((i) => `${i.path.join(".") || t.common.body}: ${i.message}`).join("; ");
  }
  return errorText(error, t);
}

const optionalInt = (text: string) => (text.trim() === "" ? undefined : Number(text));

type FormValues = {
  name: string;
  repo: string;
  baseBranch: string;
  localPath: string;
  testCommand: string;
  bootstrap: string;
  /** A ProjectIcon key; "" is none. */
  icon: ProjectIcon | "";
  /** A ProjectColor key; "" is none. */
  color: ProjectColor | "";
  concurrency: string;
  maxIterations: string;
  phases: Record<Phase, PhaseFields>;
};

function initialPhases(project?: Json<Project>): Record<Phase, PhaseFields> {
  const phases = {} as Record<Phase, PhaseFields>;
  for (const phase of PHASES) {
    phases[phase] = {
      profile: project?.agentProfiles[phase] ?? "",
      timeout: String(project?.limits.phaseTimeoutMinutes?.[phase] ?? ""),
    };
  }
  return phases;
}

function optionalCommand(key: "testCommand" | "bootstrap", text: string, editing: boolean) {
  if (text.trim() !== "") return { [key]: text.trim() };
  return editing ? { [key]: null } : {};
}

/** On create, "none" is not sent (the server leaves it null); on edit, null clears the field. */
function optionalChoice<K extends "icon" | "color", V extends string>(
  key: K,
  value: V | "",
  editing: boolean,
): { [P in K]?: V | null } {
  if (value !== "") return { [key]: value } as { [P in K]: V };
  return editing ? ({ [key]: null } as { [P in K]: null }) : {};
}

function buildInput(form: FormValues, editing: boolean): ProjectCreate | ProjectUpdate {
  const agentProfiles: Partial<Record<Phase, string | null>> = {};
  const phaseTimeoutMinutes: Partial<Record<Phase, number>> = {};
  for (const phase of PHASES) {
    const { profile, timeout } = form.phases[phase];
    // On create, an unselected phase is not sent (it stays unassigned); on edit, null unassigns it.
    if (profile !== "") agentProfiles[phase] = profile;
    else if (editing) agentProfiles[phase] = null;
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
    ...optionalChoice("icon", form.icon, editing),
    ...optionalChoice("color", form.color, editing),
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
  const profiles = useQuery(queries.agentProfiles());
  const providers = useQuery(queries.providerSettings());
  const [name, setName] = useState(project?.name ?? "");
  const [repo, setRepo] = useState(project?.repo ?? "");
  const [baseBranch, setBaseBranch] = useState(project?.baseBranch ?? "main");
  const [localPath, setLocalPath] = useState(project?.localPath ?? "");
  const [testCommand, setTestCommand] = useState(project?.testCommand ?? "");
  const [bootstrap, setBootstrap] = useState(project?.bootstrap ?? "");
  const [icon, setIcon] = useState<ProjectIcon | "">(project?.icon ?? "");
  const [color, setColor] = useState<ProjectColor | "">(project?.color ?? "");
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
          icon,
          color,
          concurrency,
          maxIterations,
          phases,
        },
        project !== undefined,
      ),
    );
  };

  return (
    <Dialog
      title={project ? t.projectForm.editTitle : t.projectForm.newTitle}
      onClose={onClose}
      dismissible={false}
    >
      <form onSubmit={submit} className="flex flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="project-name">{t.projectForm.name}</Label>
          <Input
            id="project-name"
            required
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-4 sm:flex-row">
          <div className="flex flex-1 flex-col gap-1.5">
            <Label htmlFor="project-repo">{t.projectForm.repo}</Label>
            <Input
              id="project-repo"
              required
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="owner/name"
            />
          </div>
          <div className="flex flex-col gap-1.5 sm:w-40">
            <Label htmlFor="project-base-branch">{t.projectForm.baseBranch}</Label>
            <Input
              id="project-base-branch"
              required
              value={baseBranch}
              onChange={(e) => setBaseBranch(e.target.value)}
            />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="project-local-path">{t.projectForm.localPath}</Label>
          <Input
            id="project-local-path"
            required
            value={localPath}
            onChange={(e) => setLocalPath(e.target.value)}
            placeholder={t.projectForm.localPathPlaceholder}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="project-test-command">{t.projectForm.testCommand}</Label>
          <Input
            id="project-test-command"
            value={testCommand}
            onChange={(e) => setTestCommand(e.target.value)}
            placeholder="pnpm test"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="project-bootstrap">{t.projectForm.bootstrap}</Label>
          <Input
            id="project-bootstrap"
            value={bootstrap}
            onChange={(e) => setBootstrap(e.target.value)}
            placeholder="pnpm install"
          />
        </div>

        <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-secondary/40 p-4">
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-[13px] font-semibold">{t.projectForm.icon}</legend>
            <div role="radiogroup" aria-label={t.projectForm.icon} className="flex flex-wrap gap-1">
              <label
                title={t.projectForm.noIcon}
                className={cn(PICKER_OPTION, "text-xs text-text-secondary")}
              >
                <input
                  type="radio"
                  name="project-icon"
                  value=""
                  className="sr-only"
                  aria-label={t.projectForm.noIcon}
                  checked={icon === ""}
                  onChange={() => setIcon("")}
                />
                <span aria-hidden="true">∅</span>
              </label>
              {PROJECT_ICONS.map((option) => (
                <label
                  key={option}
                  title={t.projectForm.iconNames[option]}
                  className={cn(PICKER_OPTION, "text-text-secondary")}
                >
                  <input
                    type="radio"
                    name="project-icon"
                    value={option}
                    className="sr-only"
                    aria-label={t.projectForm.iconNames[option]}
                    checked={icon === option}
                    onChange={() => setIcon(option)}
                  />
                  <ProjectIconGlyph icon={option} />
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-[13px] font-semibold">{t.projectForm.color}</legend>
            <div
              role="radiogroup"
              aria-label={t.projectForm.color}
              className="flex flex-wrap gap-1"
            >
              <label
                title={t.projectForm.noColor}
                className={cn(PICKER_OPTION, "text-xs text-text-secondary")}
              >
                <input
                  type="radio"
                  name="project-color"
                  value=""
                  className="sr-only"
                  aria-label={t.projectForm.noColor}
                  checked={color === ""}
                  onChange={() => setColor("")}
                />
                <span aria-hidden="true">∅</span>
              </label>
              {PROJECT_COLORS.map((option) => (
                <label
                  key={option}
                  title={t.projectForm.colorNames[option]}
                  className={PICKER_OPTION}
                >
                  <input
                    type="radio"
                    name="project-color"
                    value={option}
                    className="sr-only"
                    aria-label={t.projectForm.colorNames[option]}
                    checked={color === option}
                    onChange={() => setColor(option)}
                  />
                  <span
                    aria-hidden="true"
                    data-swatch={option}
                    className={cn("size-4 rounded-full", PROJECT_COLOR_SWATCH[option])}
                  />
                </label>
              ))}
            </div>
          </fieldset>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>{t.projectForm.preview}</span>
            <span data-testid="project-preview" className="text-sm">
              <ProjectLabel
                name={name.trim() || t.projectForm.previewName}
                icon={icon || null}
                color={color || null}
              />
            </span>
          </div>
        </div>

        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-[13px] font-semibold">{t.projectForm.limits}</legend>
          <div className="flex flex-col gap-4 sm:flex-row">
            <div className="flex flex-1 flex-col gap-1.5">
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
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="project-max-iterations">{t.projectForm.maxIterations}</Label>
              <Input
                id="project-max-iterations"
                type="number"
                min={1}
                max={20}
                step={1}
                value={maxIterations}
                onChange={(e) => setMaxIterations(e.target.value)}
                placeholder={t.projectForm.maxIterationsPlaceholder}
                aria-describedby="project-max-iterations-help"
              />
              <p id="project-max-iterations-help" className="text-xs text-muted-foreground">
                {t.projectForm.maxIterationsHelp}
              </p>
            </div>
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-[13px] font-semibold">{t.projectForm.agentByPhase}</legend>
          {PHASES.map((phase) => (
            <div
              key={phase}
              className="flex flex-col gap-2 rounded-lg border border-border bg-surface-secondary/40 p-4"
            >
              <h3 className="eyebrow">{t.phase[phase]}</h3>
              <div className="flex flex-col gap-4 sm:flex-row">
                <div className="flex flex-1 flex-col gap-1.5">
                  <Label htmlFor={`project-profile-${phase}`}>
                    {t.projectForm.profile(t.phase[phase])}
                  </Label>
                  <Select
                    id={`project-profile-${phase}`}
                    value={phases[phase].profile}
                    onChange={(e) => setPhase(phase, { profile: e.target.value })}
                  >
                    <option value="">{t.projectForm.noProfile}</option>
                    {(profiles.data ?? []).map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.name}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5 sm:w-40">
                  <Label htmlFor={`project-timeout-${phase}`}>
                    {t.projectForm.timeout(t.phase[phase])}
                  </Label>
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
              {disabledKinds(profiles.data, providers.data, phases[phase].profile).length > 0 && (
                <p className="text-xs text-warning-text">
                  {t.projectForm.disabledModels(
                    disabledKinds(profiles.data, providers.data, phases[phase].profile).join(", "),
                  )}{" "}
                  <Link to="/settings" className="font-medium underline underline-offset-2">
                    {t.projectForm.enableInSettings}
                  </Link>
                </p>
              )}
              {phases[phase].profile === "" && (
                <p role="note" className="text-xs text-warning-text">
                  {t.projectForm.unassignedWarning(t.phase[phase])}
                </p>
              )}
            </div>
          ))}
          {profiles.data?.length === 0 && (
            <p className="text-xs text-muted-foreground">
              {t.projectForm.noProfilesYet}{" "}
              <Link to="/profiles" className="text-primary-text underline underline-offset-2">
                {t.projectForm.createProfile}
              </Link>
            </p>
          )}
        </fieldset>

        {save.error && (
          <p role="alert" className="alert-danger">
            {project
              ? t.projectForm.saveFailed(describe(save.error, t))
              : t.projectForm.createFailed(describe(save.error, t))}
          </p>
        )}
        <div className="mt-1 flex justify-end gap-2 border-t border-border-light pt-4">
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
