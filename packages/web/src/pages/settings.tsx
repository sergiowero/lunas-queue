// Settings: el humano habilita o deshabilita cada proveedor de agente (docs/decisions/
// settings-proveedores.md). Apagar uno aplica las reglas de fallback; apagar ambos pausa el
// despacho. Los agentes vivos nunca se interrumpen.
import { AgentKind, type AgentProviderSettings } from "@lunasq/schemas";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loading, QueryError } from "../components/status.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.tsx";
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
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-border transition-colors disabled:opacity-60",
        checked ? "bg-primary" : "bg-surface-secondary",
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
  const settings = useQuery(queries.providerSettings());
  const queryClient = useQueryClient();
  const update = useMutation({
    mutationFn: (input: AgentProviderSettings) => api.updateProviderSettings(input),
    onSuccess: (saved) => queryClient.setQueryData(queries.providerSettings().queryKey, saved),
  });
  if (settings.error) return <QueryError error={settings.error} />;
  if (!settings.data) return <Loading />;
  const current = settings.data;

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">Settings</h1>
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
                onChange={(checked) => update.mutate({ ...current, [kind]: checked })}
              />
            </div>
          ))}
          {update.error && (
            <p role="alert" className="text-sm text-destructive">
              No se pudo guardar: {update.error.message}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
