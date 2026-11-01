import { setTheme, useTheme } from "../lib/theme.ts";
import { cn } from "../lib/utils.ts";

const iconProps = {
  width: 18,
  height: 18,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

function MoonIcon() {
  return (
    <svg aria-hidden="true" {...iconProps} data-icon="moon">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg aria-hidden="true" {...iconProps} data-icon="sun">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  );
}

/** Alterna claro y oscuro; el icono muestra el tema al que se cambiaría. */
export function ThemeToggle({ className }: { className?: string }) {
  const theme = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      aria-label={next === "dark" ? "Cambiar a tema oscuro" : "Cambiar a tema claro"}
      title={next === "dark" ? "Cambiar a tema oscuro" : "Cambiar a tema claro"}
      onClick={() => setTheme(next)}
      className={cn(
        "inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-text-secondary transition-all duration-150 hover:bg-surface-tertiary/70 hover:text-text active:scale-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-surface",
        className,
      )}
    >
      {theme === "dark" ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}
