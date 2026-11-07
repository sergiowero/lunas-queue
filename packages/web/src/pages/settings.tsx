// Settings: the human enables or disables each agent provider and sets the global limit of
// concurrent agents (docs/decisions/settings-proveedores.md). Turning a provider off applies the
// fallback rules; turning both off pauses dispatch. Live agents are never interrupted, neither
// when turning a provider off nor when lowering the limit. The global verification iteration cap
// (a project's own value overrides it) is saved here too.
import {
  AgentKind,
  type AgentProviderPatch,
  ConcurrencySettings,
  MAX_GLOBAL_CONCURRENCY,
  MAX_VERIFICATION_ITERATIONS,
  VerificationSettings,
} from "@lunasq/schemas";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useId, useState } from "react";
import { Loading, QueryError } from "../components/status.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.tsx";
import { Input, Label } from "../components/ui/input.tsx";
import { api } from "../lib/api.ts";
import { useErrorText } from "../lib/error-text.ts";
import { useT } from "../lib/i18n.ts";
import { queries } from "../lib/queries.ts";
import { cn } from "../lib/utils.ts";

function Switch({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      // aria-disabled and not disabled: a disabled button loses focus and the keyboard is left with nowhere to go.
      // aria-disabled and not disabled: a disabled button loses focus and the keyboard is left with nowhere to go.
      aria-disabled={disabled}
      onClick={() => {
        if (!disabled) onChange(!checked);
      }}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-disabled:opacity-60",
        // The off state uses a gray with enough contrast against the card (≥3:1) to spot it.
        checked ? "border-primary bg-primary" : "border-text-muted bg-text-muted",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "inline-block size-4 rounded-full bg-white shadow transition-transform",
          checked ? "translate-x-6" : "translate-x-1",
        )}
      />
    </button>
  );
}

export function SettingsPage() {
  const t = useT();
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">{t.settings.title}</h1>
      <ProvidersSection />
      <ConcurrencySection />
      <VerificationSection />
    </div>
  );
}

function ConcurrencySection() {
  const t = useT();
  const errorText = useErrorText();
  const inputId = useId();
  const messageId = useId();
  const settings = useQuery(queries.concurrencySettings());
  const queryClient = useQueryClient();
  // null: the field follows the value read; a text: what the human is typing.
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  // Last limit a PUT saved and that no later read managed to read: the server already
  // has it, but the cache still holds an earlier value.
  const [unread, setUnread] = useState<{ value: number; at: number } | null>(null);
  const update = useMutation({
    mutationFn: (input: ConcurrencySettings) => api.updateConcurrencySettings(input),
    // It is re-read instead of overwriting the cache with the PUT response, and the field only goes back to
    // following the server when the read arrived: this way it shows the saved value and not an old one.
    // invalidateQueries does not throw if the read fails: in that case the field keeps the value the
    // PUT confirmed and the notice says it was saved, instead of showing the previous value.
    onSuccess: async (saved) => {
      const queryKey = queries.concurrencySettings().queryKey;
      await queryClient.invalidateQueries({ queryKey });
      if (queryClient.getQueryState(queryKey)?.status === "error") {
        setDraft(String(saved.globalConcurrency));
        setUnread({ value: saved.globalConcurrency, at: Date.now() });
      } else {
        setDraft(null);
        setUnread(null);
      }
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (update.isPending || !settings.data) return;
    const text = draft ?? String(settings.data.globalConcurrency);
    const parsed = ConcurrencySettings.safeParse({
      globalConcurrency: text.trim() === "" ? Number.NaN : Number(text),
    });
    if (!parsed.success) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    update.mutate(parsed.data);
  }

  // A read after the PUT already reflects what was saved: then settings.data governs.
  const savedUnread = unread && (settings.dataUpdatedAt ?? 0) < unread.at ? unread.value : null;
  const effective = savedUnread ?? settings.data?.globalConcurrency;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t.settings.concurrencyTitle}</CardTitle>
        <p className="text-sm text-muted-foreground">{t.settings.concurrencyHelp}</p>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!settings.data && !settings.error && <Loading />}
        {settings.data && (
          <form onSubmit={submit} noValidate className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor={inputId}>{t.settings.concurrentAgents}</Label>
              <Input
                id={inputId}
                type="number"
                inputMode="numeric"
                min={1}
                max={MAX_GLOBAL_CONCURRENCY}
                step={1}
                className="w-28"
                value={draft ?? String(settings.data.globalConcurrency)}
                aria-invalid={invalid}
                aria-describedby={invalid ? messageId : undefined}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setInvalid(false);
                }}
              />
            </div>
            <Button type="submit" disabled={update.isPending}>
              {t.settings.save}
            </Button>
            {invalid && (
              <p id={messageId} className="basis-full text-sm text-destructive">
                {t.settings.concurrencyInvalid(MAX_GLOBAL_CONCURRENCY)}
              </p>
            )}
          </form>
        )}
        {settings.error && (
          <p role="alert" className="text-sm text-destructive">
            {settings.data
              ? savedUnread === null
                ? t.settings.limitUpdateFailed
                : t.settings.limitSavedUnread(savedUnread)
              : t.settings.limitReadFailed}
            {errorText(settings.error)}
          </p>
        )}
        {update.error && effective !== undefined && (
          <p role="alert" className="text-sm text-destructive">
            {t.settings.limitSaveFailed(effective, errorText(update.error))}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function VerificationSection() {
  const t = useT();
  const errorText = useErrorText();
  const inputId = useId();
  const messageId = useId();
  const settings = useQuery(queries.verificationSettings());
  const queryClient = useQueryClient();
  // null: the field follows the value read; a text: what the human is typing.
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  // Last cap a PUT saved and that no later read managed to read (see ConcurrencySection).
  const [unread, setUnread] = useState<{ value: number; at: number } | null>(null);
  const update = useMutation({
    mutationFn: (input: VerificationSettings) => api.updateVerificationSettings(input),
    onSuccess: async (saved) => {
      const queryKey = queries.verificationSettings().queryKey;
      await queryClient.invalidateQueries({ queryKey });
      if (queryClient.getQueryState(queryKey)?.status === "error") {
        setDraft(String(saved.maxVerificationIterations));
        setUnread({ value: saved.maxVerificationIterations, at: Date.now() });
      } else {
        setDraft(null);
        setUnread(null);
      }
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (update.isPending || !settings.data) return;
    const text = draft ?? String(settings.data.maxVerificationIterations);
    const parsed = VerificationSettings.safeParse({
      maxVerificationIterations: text.trim() === "" ? Number.NaN : Number(text),
    });
    if (!parsed.success) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    update.mutate(parsed.data);
  }

  const savedUnread = unread && (settings.dataUpdatedAt ?? 0) < unread.at ? unread.value : null;
  const effective = savedUnread ?? settings.data?.maxVerificationIterations;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t.settings.verificationTitle}</CardTitle>
        <p className="text-sm text-muted-foreground">{t.settings.verificationHelp}</p>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!settings.data && !settings.error && <Loading />}
        {settings.data && (
          <form onSubmit={submit} noValidate className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor={inputId}>{t.settings.maxIterations}</Label>
              <Input
                id={inputId}
                type="number"
                inputMode="numeric"
                min={1}
                max={MAX_VERIFICATION_ITERATIONS}
                step={1}
                className="w-28"
                value={draft ?? String(settings.data.maxVerificationIterations)}
                aria-invalid={invalid}
                aria-describedby={invalid ? messageId : undefined}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setInvalid(false);
                }}
              />
            </div>
            <Button type="submit" disabled={update.isPending}>
              {t.settings.saveIterations}
            </Button>
            {invalid && (
              <p id={messageId} className="basis-full text-sm text-destructive">
                {t.settings.iterationsInvalid(MAX_VERIFICATION_ITERATIONS)}
              </p>
            )}
          </form>
        )}
        {settings.error && (
          <p role="alert" className="text-sm text-destructive">
            {settings.data
              ? savedUnread === null
                ? t.settings.iterationsUpdateFailed
                : t.settings.iterationsSavedUnread(savedUnread)
              : t.settings.iterationsReadFailed}
            {errorText(settings.error)}
          </p>
        )}
        {update.error && effective !== undefined && (
          <p role="alert" className="text-sm text-destructive">
            {t.settings.iterationsSaveFailed(effective, errorText(update.error))}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function ProvidersSection() {
  const t = useT();
  const errorText = useErrorText();
  const settings = useQuery(queries.providerSettings());
  const queryClient = useQueryClient();
  const update = useMutation({
    mutationFn: (input: AgentProviderPatch) => api.updateProviderSettings(input),
    // It is re-read instead of overwriting the cache with the response: a slow PUT must not restore a
    // view earlier than a later change (from another tab). The mutation stays pending until
    // the fresh read arrives, so the switches do not move with old data.
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queries.providerSettings().queryKey }),
  });
  if (!settings.data) {
    return settings.error ? <QueryError error={settings.error} /> : <Loading />;
  }
  const current = settings.data;
  // The last change's PUT succeeded and no later read managed to read it: the server already
  // saved, but the switches show an earlier state. If a read after the PUT
  // succeeded, the data already reflects the change and a later failure is unrelated to it.
  const savedButUnread =
    update.isSuccess &&
    settings.errorUpdatedAt >= update.submittedAt &&
    settings.dataUpdatedAt < update.submittedAt;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t.settings.providersTitle}</CardTitle>
        <p className="text-sm text-muted-foreground">{t.settings.providersHelp}</p>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {AgentKind.options.map((kind) => (
          <div key={kind} className="flex items-center justify-between gap-4">
            <div className="flex flex-col">
              <span className="font-medium">{t.settings.providers[kind]}</span>
              <span className="text-sm text-muted-foreground">
                {t.settings.providerDescriptions[kind]}
              </span>
            </div>
            <Switch
              label={t.settings.providers[kind]}
              checked={current[kind]}
              disabled={update.isPending}
              onChange={(checked) => update.mutate({ [kind]: checked })}
            />
          </div>
        ))}
        {settings.error && (
          <p role="alert" className="text-sm text-destructive">
            {savedButUnread ? t.settings.providersSavedUnread : t.settings.providersUpdateFailed}
            {errorText(settings.error)}
          </p>
        )}
        {update.error && (
          <p role="alert" className="text-sm text-destructive">
            {t.settings.saveFailed(errorText(update.error))}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
