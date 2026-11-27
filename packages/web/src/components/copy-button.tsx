// Small icon button that copies a value (branch, worktree path, PR URL, herdr command) to the
// clipboard and confirms it for a moment. Without clipboard access it does nothing visible.
import { useEffect, useState } from "react";
import { useT } from "../lib/i18n.ts";
import { cn } from "../lib/utils.ts";

const CONFIRM_MS = 1500;

export function CopyButton({
  value,
  label,
  className,
}: {
  value: string;
  /** What is copied, for the accessible name («Copiar branch»). */
  label: string;
  className?: string;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), CONFIRM_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // No clipboard (insecure context or denied permission): the text stays selectable.
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={t.common.copyAria(label)}
      title={copied ? t.common.copied : t.common.copy}
      className={cn(
        "ml-1 inline-flex size-6 shrink-0 items-center justify-center rounded-md align-middle text-text-secondary transition-colors hover:bg-surface-secondary hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
        className,
      )}
    >
      {copied ? (
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="size-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M5 12l5 5L20 7" />
        </svg>
      ) : (
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="size-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="9" y="9" width="11" height="11" rx="2" />
          <path d="M5 15V6a2 2 0 0 1 2-2h9" />
        </svg>
      )}
      <span className="sr-only" aria-live="polite">
        {copied ? t.common.copied : ""}
      </span>
    </button>
  );
}
