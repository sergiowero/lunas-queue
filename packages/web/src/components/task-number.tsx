// Task number (#N): how a task is identified to people, next to its goal (ADR 0015).
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
