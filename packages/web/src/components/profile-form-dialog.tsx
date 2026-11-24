// Creation and editing of agent profiles (docs/decisions/agent-profiles.md): a name and an ordered
// list of models, the first the primary and the rest its fallbacks. Validation is the server's, which
// also checks each model's reserved CLI flags; here only its issues are shown.
import {
  type AgentKind,
  type AgentProfile,
  type AgentProfileCreate,
  EFFORT_LEVELS,
  type EffortLevel,
  MAX_PROFILE_MODELS,
  type ProfileModel,
} from "@lunasq/schemas";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useRef, useState } from "react";
import { ApiError, api, type Json } from "../lib/api.ts";
import type { Dictionary } from "../lib/dictionary/index.ts";
import { errorText } from "../lib/error-text.ts";
import { useT } from "../lib/i18n.ts";
import { queries } from "../lib/queries.ts";
import { Button } from "./ui/button.tsx";
import { Dialog } from "./ui/dialog.tsx";
import { Input, Label, Select, Textarea } from "./ui/input.tsx";

const PROVIDER_COMMAND: Record<AgentKind, string> = {
  claude: "claude",
  copilot: "copilot",
  codex: "codex",
  opencode: "opencode",
};

type ModelFields = {
  key: number;
  kind: AgentKind;
  model: string;
  effort: string;
  args: string;
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

function toInput(name: string, models: ModelFields[]): AgentProfileCreate {
  return {
    name: name.trim(),
    models: models.map(
      ({ kind, model, effort, args }): ProfileModel => ({
        kind,
        ...(model.trim() !== "" && { model: model.trim() }),
        ...(effort !== "" && { effort: effort as EffortLevel }),
        args: parseArgs(args),
      }),
    ),
  };
}

export function ProfileFormDialog({
  profile,
  onClose,
}: {
  /** With a profile, the form edits; without it, it creates. */
  profile?: Json<AgentProfile>;
  onClose: () => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const settings = useQuery(queries.providerSettings());
  const nextKey = useRef(0);
  const blank = (): ModelFields => ({
    key: nextKey.current++,
    kind: "claude",
    model: "",
    effort: "",
    args: "",
  });
  const [name, setName] = useState(profile?.name ?? "");
  const [models, setModels] = useState<ModelFields[]>(() =>
    profile
      ? profile.models.map((m) => ({
          key: nextKey.current++,
          kind: m.kind,
          model: m.model ?? "",
          effort: m.effort ?? "",
          args: m.args.join("\n"),
        }))
      : [blank()],
  );

  const save = useMutation({
    mutationFn: (input: AgentProfileCreate) =>
      profile ? api.updateAgentProfile(profile.id, input) : api.createAgentProfile(input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["agent-profiles"] });
      onClose();
    },
  });

  const patch = (index: number, change: Partial<ModelFields>) =>
    setModels((current) => current.map((m, i) => (i === index ? { ...m, ...change } : m)));
  const move = (index: number, by: -1 | 1) =>
    setModels((current) => {
      const target = index + by;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target] as ModelFields, next[index] as ModelFields];
      return next;
    });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate(toInput(name, models));
  };

  return (
    <Dialog title={profile ? t.profileForm.editTitle : t.profileForm.newTitle} onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor="profile-name">{t.profileForm.name}</Label>
          <Input
            id="profile-name"
            required
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <fieldset className="flex flex-col gap-3">
          <legend className="text-sm font-medium">{t.profileForm.models}</legend>
          {models.map((model, index) => {
            const position = index + 1;
            const disabled = settings.data !== undefined && settings.data[model.kind] === false;
            return (
              <div
                key={model.key}
                className="flex flex-col gap-2 rounded-md border border-border p-3"
              >
                <div className="flex items-end gap-2">
                  <div className="flex flex-1 flex-col gap-1">
                    <Label htmlFor={`profile-kind-${model.key}`}>
                      {t.profileForm.provider(position)}
                    </Label>
                    <Select
                      id={`profile-kind-${model.key}`}
                      value={model.kind}
                      onChange={(e) => patch(index, { kind: e.target.value as AgentKind })}
                    >
                      <option value="claude">Claude Code</option>
                      <option value="copilot">GitHub Copilot CLI</option>
                      <option value="codex">OpenAI Codex CLI</option>
                      <option value="opencode">OpenCode CLI</option>
                    </Select>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={t.profileForm.moveUp(position)}
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                  >
                    ↑
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={t.profileForm.moveDown(position)}
                    disabled={index === models.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    ↓
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={t.profileForm.remove(position)}
                    disabled={models.length === 1}
                    onClick={() => setModels((current) => current.filter((_, i) => i !== index))}
                  >
                    ✕
                  </Button>
                </div>
                {disabled && (
                  <p className="text-xs text-warning-text">{t.profileForm.providerDisabled}</p>
                )}
                <div className="flex gap-4">
                  <div className="flex flex-1 flex-col gap-1">
                    <Label htmlFor={`profile-model-${model.key}`}>
                      {t.profileForm.model(position)}
                    </Label>
                    <Input
                      id={`profile-model-${model.key}`}
                      value={model.model}
                      onChange={(e) => patch(index, { model: e.target.value })}
                    />
                  </div>
                  <div className="flex w-40 flex-col gap-1">
                    <Label htmlFor={`profile-effort-${model.key}`}>
                      {t.profileForm.effort(position)}
                    </Label>
                    <Select
                      id={`profile-effort-${model.key}`}
                      value={model.effort}
                      onChange={(e) => patch(index, { effort: e.target.value })}
                    >
                      <option value="">{t.profileForm.effortDefault}</option>
                      {EFFORT_LEVELS.map((level) => (
                        <option key={level} value={level}>
                          {level}
                        </option>
                      ))}
                    </Select>
                  </div>
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor={`profile-args-${model.key}`}>
                    {t.profileForm.args(position)}
                  </Label>
                  <p
                    id={`profile-args-help-${model.key}`}
                    className="text-xs text-muted-foreground"
                  >
                    {t.profileForm.argsHelp.before}
                    <code>{PROVIDER_COMMAND[model.kind]}</code>
                    {t.profileForm.argsHelp.after}
                  </p>
                  <Textarea
                    id={`profile-args-${model.key}`}
                    aria-describedby={`profile-args-help-${model.key}`}
                    rows={2}
                    value={model.args}
                    onChange={(e) => patch(index, { args: e.target.value })}
                  />
                </div>
              </div>
            );
          })}
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              disabled={models.length >= MAX_PROFILE_MODELS}
              onClick={() => setModels((current) => [...current, blank()])}
            >
              {t.profileForm.add}
            </Button>
            {models.length >= MAX_PROFILE_MODELS && (
              <span className="text-xs text-muted-foreground">
                {t.profileForm.maxModels(MAX_PROFILE_MODELS)}
              </span>
            )}
          </div>
        </fieldset>

        {save.error && (
          <p role="alert" className="text-sm text-destructive">
            {profile
              ? t.profileForm.saveFailed(describe(save.error, t))
              : t.profileForm.createFailed(describe(save.error, t))}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button type="submit" disabled={save.isPending}>
            {profile ? t.profileForm.saveChanges : t.profileForm.create}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
