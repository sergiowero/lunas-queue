import { Link, Outlet } from "@tanstack/react-router";
import { useInProgressCount } from "../lib/in-progress.ts";
import { useInbox } from "../lib/inbox.ts";
import { useLiveUpdates } from "../lib/live.ts";
import { useOpenPrCount } from "../lib/open-prs.ts";
import { cn } from "../lib/utils.ts";
import { DispatchPausedBanner } from "./dispatch-paused-banner.tsx";
import { PlusIcon, SettingsIcon } from "./icons.tsx";
import { ThemeToggle } from "./theme-toggle.tsx";
import { Badge } from "./ui/badge.tsx";
import { buttonVariants } from "./ui/button.tsx";

const nav =
  "shrink-0 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-secondary hover:text-text";
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
  const inProgressCount = useInProgressCount();
  const openPrs = useOpenPrCount();
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-border bg-surface/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-2 px-4 sm:gap-4 sm:px-6">
          <Link
            to="/queue"
            aria-label="LunasQ"
            className="flex shrink-0 items-center gap-2.5 font-bold tracking-tight"
          >
            <BrandMark />
            <span className="hidden sm:inline">LunasQ</span>
          </Link>
          <nav className="-my-2 flex min-w-0 gap-1 overflow-x-auto px-1 py-2">
            <Link to="/queue" className={nav} activeProps={active}>
              Cola
            </Link>
            <Link
              to="/in-progress"
              className={nav}
              activeProps={active}
              aria-label={
                inProgressCount > 0
                  ? `En curso, ${inProgressCount} ${inProgressCount === 1 ? "tarea" : "tareas"}`
                  : undefined
              }
            >
              En curso
              {inProgressCount > 0 && (
                <Badge variant="secondary" className="ml-1.5">
                  {inProgressCount}
                </Badge>
              )}
            </Link>
            <Link
              to="/completed"
              className={nav}
              activeProps={active}
              aria-label={openPrs > 0 ? `Completed, ${openPrs} PR abiertos` : "Completed"}
            >
              Completed
              {openPrs > 0 && (
                <Badge variant="success" className="ml-1.5">
                  {openPrs}
                </Badge>
              )}
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
          </nav>
          <Link to="/tasks/new" className={cn(buttonVariants({ size: "sm" }), "ml-auto shrink-0")}>
            <PlusIcon />
            Nueva tarea
          </Link>
          <Link
            to="/settings"
            aria-label="Settings"
            title="Settings"
            className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-text-secondary transition-all duration-150 hover:bg-surface-tertiary/70 hover:text-text active:scale-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
            activeProps={active}
          >
            <SettingsIcon />
          </Link>
          <ThemeToggle className="shrink-0" />
        </div>
      </header>
      <DispatchPausedBanner />
      <main className="mx-auto max-w-7xl px-6 py-6">
        <Outlet />
      </main>
    </div>
  );
}
