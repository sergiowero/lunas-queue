import { Link, Outlet } from "@tanstack/react-router";
import { useInbox } from "../lib/inbox.ts";
import { useLiveUpdates } from "../lib/live.ts";
import { Badge } from "./ui/badge.tsx";

const nav = "rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground";
const active = { className: "bg-muted text-foreground" };

export function Layout() {
  useLiveUpdates();
  const { count } = useInbox();
  return (
    <div className="min-h-screen">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-7xl items-center gap-4 px-4 py-3">
          <Link to="/queue" className="font-semibold">
            LunasQ
          </Link>
          <nav className="flex gap-1">
            <Link to="/queue" className={nav} activeProps={active}>
              Cola
            </Link>
            <Link
              to="/inbox"
              className={nav}
              activeProps={active}
              aria-label={count > 0 ? `Bandeja, ${count} pendientes` : "Bandeja"}
            >
              Bandeja
              {count > 0 && (
                <Badge variant="destructive" className="ml-1.5">
                  {count}
                </Badge>
              )}
            </Link>
            <Link
              to="/projects"
              className={nav}
              activeOptions={{ exact: true }}
              activeProps={active}
            >
              Proyectos
            </Link>
            <Link to="/dag" className={nav} activeProps={active}>
              DAG
            </Link>
            <Link to="/tasks/new" className={nav} activeProps={active}>
              Nueva tarea
            </Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
