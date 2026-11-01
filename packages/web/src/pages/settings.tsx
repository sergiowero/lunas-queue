// Settings: el humano habilita o deshabilita cada proveedor de agente (docs/decisions/
// settings-proveedores.md). Apagar uno aplica las reglas de fallback; apagar ambos pausa el
// despacho. Los agentes vivos nunca se interrumpen.
import { AgentKind, type AgentProviderPatch } from "@lunasq/schemas";
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
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60",
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
                onChange={(checked) => update.mutate({ [kind]: checked })}
              />
            </div>
          ))}
          {settings.error && (
            <p role="alert" className="text-sm text-destructive">
              No se pudo actualizar la configuración; se muestra el último estado leído:{" "}
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
    </div>
  );
}
