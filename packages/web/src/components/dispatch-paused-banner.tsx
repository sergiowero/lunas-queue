// Aviso global: con todos los proveedores de agente deshabilitados en Settings, el scheduler no
// despacha y las tareas esperan en queued. Se muestra en cualquier página.
import { AgentKind } from "@lunasq/schemas";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { queries } from "../lib/queries.ts";

export function DispatchPausedBanner() {
  const settings = useQuery(queries.providerSettings());
  if (settings.isError && !settings.data) {
    return (
      <div role="status" className="border-b border-border bg-warning/10 text-sm text-text">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-2 px-6 py-2">
          <strong>Estado del despacho desconocido:</strong>
          <span>
            No se pudo leer la configuración de proveedores; si ambos están deshabilitados, las
            tareas esperan en cola.
          </span>
          <Link to="/settings" className="font-medium underline">
            Ir a Settings
          </Link>
        </div>
      </div>
    );
  }
  if (!settings.data || AgentKind.options.some((kind) => settings.data[kind])) return null;
  return (
    <div role="status" className="border-b border-border bg-warning/10 text-sm text-text">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-2 px-6 py-2">
        <strong>Despacho en pausa:</strong>
        <span>
          Claude y Copilot están deshabilitados, así que las tareas esperan en cola. Los agentes
          vivos siguen corriendo.
        </span>
        <Link to="/settings" className="font-medium underline">
          Ir a Settings
        </Link>
      </div>
    </div>
  );
}
