import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.ts";

const field =
  "w-full rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-text shadow-xs placeholder:text-text-muted transition-colors hover:border-border-strong focus-visible:border-primary/70 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/15 disabled:pointer-events-none disabled:opacity-50";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={cn(field, "h-9", className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea className={cn(field, "min-h-20", className)} {...props} />;
}

export function Select({ className, ...props }: ComponentProps<"select">) {
  return <select className={cn(field, "h-9", className)} {...props} />;
}

export function Label({ className, ...props }: ComponentProps<"label">) {
  // biome-ignore lint/a11y/noLabelWithoutControl: el control se asocia con htmlFor desde quien llama.
  return <label className={cn("text-[13px] font-medium text-text", className)} {...props} />;
}
