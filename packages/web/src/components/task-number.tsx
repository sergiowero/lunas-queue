// Número de tarea (#N): cómo se identifica una tarea ante personas, junto a su intent (ADR 0015).
import { cn } from "../lib/utils.ts";

export function taskLabel(number: number): string {
  return `#${number}`;
}

export function TaskNumber({ number, className }: { number: number; className?: string }) {
  return (
    <span
      className={cn("shrink-0 font-mono text-xs text-muted-foreground tabular-nums", className)}
    >
      {taskLabel(number)}
    </span>
  );
}
