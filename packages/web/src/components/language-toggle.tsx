import { setLanguage, useLanguage, useT } from "../lib/i18n.ts";
import { cn } from "../lib/utils.ts";

const flagProps = {
  width: 22,
  height: 16,
  viewBox: "0 0 22 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.25,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

/** Outline of the flag of Mexico: three vertical bands with the emblem in the middle one. */
function MexicoFlag() {
  return (
    <svg aria-hidden="true" {...flagProps} data-flag="mx">
      <rect x="1" y="1" width="20" height="14" rx="2" />
      <path d="M7.67 1v14M14.33 1v14" />
      <circle cx="11" cy="8" r="1.75" />
    </svg>
  );
}

/** Outline of the flag of the United States: stripes and the canton with its stars. */
function UnitedStatesFlag() {
  return (
    <svg aria-hidden="true" {...flagProps} data-flag="us">
      <rect x="1" y="1" width="20" height="14" rx="2" />
      <path d="M10 5.33h11M10 9.67h11M1 11.5h20" />
      <rect x="1" y="1" width="9" height="6.5" rx="1" />
      <path
        d="M3.5 3.25h.01M5.5 3.25h.01M7.5 3.25h.01M4.5 5.25h.01M6.5 5.25h.01"
        strokeWidth={1.75}
      />
    </svg>
  );
}

/** Switches between Spanish and English; it shows the current language with the outline of its flag. */
export function LanguageToggle({ className }: { className?: string }) {
  const language = useLanguage();
  const t = useT();
  const next = language === "es" ? "en" : "es";
  return (
    <button
      type="button"
      aria-label={t.language.switchTo}
      title={t.language.switchTo}
      onClick={() => setLanguage(next)}
      className={cn(
        "inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg px-2 text-xs font-semibold tracking-wide text-text-secondary transition-all duration-150 hover:bg-surface-tertiary/70 hover:text-text active:scale-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-surface",
        className,
      )}
    >
      {language === "es" ? <MexicoFlag /> : <UnitedStatesFlag />}
      <span>{t.language.code}</span>
    </button>
  );
}
