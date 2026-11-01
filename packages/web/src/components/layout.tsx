import { Link, Outlet } from "@tanstack/react-router";
import { useInbox } from "../lib/inbox.ts";
import { useLiveUpdates } from "../lib/live.ts";
import { ThemeToggle } from "./theme-toggle.tsx";
import { Badge } from "./ui/badge.tsx";

const nav =
  "rounded-lg px-3 py-1.5 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-secondary hover:text-text";
const active = { className: "bg-primary/10 text-primary-text hover:bg-primary/10" };

/** Marca de LunasQ: tile con degradado índigo-violeta y tres fases lunares en cola (nueva, cuarto, llena). */
function BrandMark() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 32 32"
      className="size-8 shrink-0 drop-shadow-[0_4px_12px_rgb(99_102_241/0.35)]"
    >
      <defs>
        <linearGradient id="lunasq-mark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#6366f1" />
          <stop offset="1" stopColor="#a855f7" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#lunasq-mark)" />
      <g fill="none" stroke="white" strokeWidth="1.6">
        <circle cx="7.5" cy="16" r="3.6" />
        <circle cx="16" cy="16" r="3.6" />
      </g>
      <path d="M16 12.4a3.6 3.6 0 0 1 0 7.2z" fill="white" />
      <circle cx="24.5" cy="16" r="4.4" fill="white" />
    </svg>
  );
}

export function Layout() {
  useLiveUpdates();
  const { count } = useInbox();
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-border bg-surface/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-4 px-6">
          <Link to="/queue" className="flex items-center gap-2.5 font-bold tracking-tight">
            <BrandMark />
            LunasQ
          </Link>
          <nav className="flex gap-1">
            <Link to="/queue" className={nav} activeProps={active}>
              Cola
            </Link>
            <Link to="/in-progress" className={nav} activeProps={active}>
              En curso
            </Link>
            <Link to="/completed" className={nav} activeProps={active}>
              Completed
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
            <Link to="/tasks/new" className={nav} activeProps={active}>
              Nueva tarea
            </Link>
          </nav>
          <ThemeToggle className="ml-auto" />
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-6 py-6">
        <Outlet />
      </main>
    </div>
  );
}
