// Settings: el humano habilita o deshabilita cada proveedor de agente y fija el límite global de
// agentes concurrentes (docs/decisions/settings-proveedores.md). Apagar un proveedor aplica las
// reglas de fallback; apagar ambos pausa el despacho. Los agentes vivos nunca se interrumpen, ni
// al apagar un proveedor ni al bajar el límite.
import {
  AgentKind,
  type AgentProviderPatch,
  ConcurrencySettings,
  MAX_GLOBAL_CONCURRENCY,
} from "@lunasq/schemas";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useId, useState } from "react";
import { Loading, QueryError } from "../components/status.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.tsx";
import { Input, Label } from "../components/ui/input.tsx";
import { api } from "../lib/api.ts";
import { queries } from "../lib/queries.ts";
import { cn } from "../lib/utils.ts";

const LABEL: Record<AgentKind, string> = { claude: "Claude", copilot: "Copilot" };
const DESCRIPTION: Record<AgentKind, string> = {
  claude: "Claude Code",
  copilot: "GitHub Copilot CLI",
};

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
      // aria-disabled y no disabled: un botón disabled pierde el foco y el teclado se queda sin sitio.
      // aria-disabled y no disabled: un botón disabled pierde el foco y el teclado se queda sin sitio.
      aria-disabled={disabled}
      onClick={() => {
        if (!disabled) onChange(!checked);
      }}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-disabled:opacity-60",
        // El apagado usa un gris con contraste suficiente contra la tarjeta (≥3:1) para localizarlo.
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
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">Settings</h1>
      <ProvidersSection />
      <ConcurrencySection />
    </div>
  );
}

const CONCURRENCY_INVALID = `Escribe un número entero entre 1 y ${MAX_GLOBAL_CONCURRENCY}.`;

function ConcurrencySection() {
  const inputId = useId();
  const messageId = useId();
  const settings = useQuery(queries.concurrencySettings());
  const queryClient = useQueryClient();
  // null: el campo sigue al valor leído; un texto: lo que el humano está escribiendo.
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  // Último límite que un PUT guardó y que ninguna lectura posterior llegó a leer: el servidor ya lo
  // tiene, pero la caché sigue con un valor anterior.
  const [unread, setUnread] = useState<{ value: number; at: number } | null>(null);
  const update = useMutation({
    mutationFn: (input: ConcurrencySettings) => api.updateConcurrencySettings(input),
    // Se vuelve a leer en vez de pisar la caché con la respuesta del PUT, y el campo solo vuelve a
    // seguir al servidor cuando llegó la lectura: así muestra el valor guardado y no uno viejo.
    // invalidateQueries no lanza si la lectura falla: en ese caso el campo conserva el valor que el
    // PUT confirmó y el aviso dice que se guardó, en vez de mostrar el valor anterior.
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

  // Una lectura posterior al PUT ya refleja lo guardado: entonces rige settings.data.
  const savedUnread = unread && (settings.dataUpdatedAt ?? 0) < unread.at ? unread.value : null;
  const effective = savedUnread ?? settings.data?.globalConcurrency;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Concurrencia</CardTitle>
        <p className="text-sm text-muted-foreground">
          Máximo de agentes vivos a la vez, entre todos los proyectos y fases (incluye los que
          esperan una respuesta). Subirlo despacha de inmediato las tareas en cola; bajarlo no
          interrumpe a los que ya corren, solo frena los despachos nuevos.
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!settings.data && !settings.error && <Loading />}
        {settings.data && (
          <form onSubmit={submit} noValidate className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor={inputId}>Agentes concurrentes</Label>
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
              Guardar
            </Button>
            {invalid && (
              <p id={messageId} className="basis-full text-sm text-destructive">
                {CONCURRENCY_INVALID}
              </p>
            )}
          </form>
        )}
        {settings.error && (
          <p role="alert" className="text-sm text-destructive">
            {settings.data
              ? savedUnread === null
                ? "No se pudo actualizar el límite; se muestra el último valor leído: "
                : `El límite se guardó (${savedUnread}), pero no se pudo volver a leer: `
              : "No se pudo leer el límite de concurrencia: "}
            {settings.error.message}
          </p>
        )}
        {update.error && effective !== undefined && (
          <p role="alert" className="text-sm text-destructive">
            No se pudo guardar el límite; sigue vigente {effective}: {update.error.message}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function ProvidersSection() {
  const settings = useQuery(queries.providerSettings());
  const queryClient = useQueryClient();
  const update = useMutation({
    mutationFn: (input: AgentProviderPatch) => api.updateProviderSettings(input),
    // Se vuelve a leer en vez de pisar la caché con la respuesta: un PUT lento no debe restaurar una
    // vista anterior a un cambio posterior (de otra pestaña). La mutación sigue pendiente hasta
    // que llega la lectura fresca, así los interruptores no se mueven con datos viejos.
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queries.providerSettings().queryKey }),
  });
  if (!settings.data) {
    return settings.error ? <QueryError error={settings.error} /> : <Loading />;
  }
  const current = settings.data;
  // El PUT del último cambio tuvo éxito y ninguna lectura posterior llegó a leerlo: el servidor ya
  // guardó, pero los interruptores muestran un estado anterior. Si una lectura posterior al PUT
  // tuvo éxito, los datos ya reflejan el cambio y un fallo más tardío es ajeno a él.
  const savedButUnread =
    update.isSuccess &&
    settings.errorUpdatedAt >= update.submittedAt &&
    settings.dataUpdatedAt < update.submittedAt;

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Proveedores de agente</CardTitle>
          <p className="text-sm text-muted-foreground">
            Deshabilita un proveedor cuando se agote su límite de uso: no recibirá despachos nuevos
            y se aplica el fallback al otro. Con ambos deshabilitados, las tareas esperan en cola.
            Los agentes que ya corren no se interrumpen.
          </p>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {AgentKind.options.map((kind) => (
            <div key={kind} className="flex items-center justify-between gap-4">
              <div className="flex flex-col">
                <span className="font-medium">{LABEL[kind]}</span>
                <span className="text-sm text-muted-foreground">{DESCRIPTION[kind]}</span>
              </div>
              <Switch
                label={LABEL[kind]}
                checked={current[kind]}
                disabled={update.isPending}
                onChange={(checked) => update.mutate({ [kind]: checked })}
              />
            </div>
          ))}
          {settings.error && (
            <p role="alert" className="text-sm text-destructive">
              {savedButUnread
                ? "El cambio se guardó, pero no se pudo leer el estado; los interruptores muestran el último estado leído, que puede no reflejarlo: "
                : "No se pudo actualizar la configuración; se muestra el último estado leído: "}
              {settings.error.message}
            </p>
          )}
          {update.error && (
            <p role="alert" className="text-sm text-destructive">
              No se pudo guardar: {update.error.message}
            </p>
          )}
        </CardContent>
      </Card>
    </>
  );
}
