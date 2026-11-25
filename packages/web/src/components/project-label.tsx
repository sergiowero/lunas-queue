// How the UI shows a task's project: its optional icon, then its name tinted with its optional
// color (docs/decisions/0008-config-proyecto.md). The name is always shown, so the color is never
// the only way to tell projects apart; the icon is decorative.
import type { ProjectColor, ProjectIcon } from "@lunasq/schemas";
import { cn } from "../lib/utils.ts";
import { ProjectIconGlyph } from "./icons.tsx";

// Literal class names so that Tailwind generates each utility from the `--color-project-*` tokens,
// which have a light and a dark value.
const COLOR_CLASS: Record<ProjectColor, string> = {
  red: "text-project-red",
  orange: "text-project-orange",
  amber: "text-project-amber",
  green: "text-project-green",
  teal: "text-project-teal",
  blue: "text-project-blue",
  violet: "text-project-violet",
  pink: "text-project-pink",
};

/** Solid swatch of the project color selector, from the same `--color-project-*` tokens. */
export const PROJECT_COLOR_SWATCH: Record<ProjectColor, string> = {
  red: "bg-project-red",
  orange: "bg-project-orange",
  amber: "bg-project-amber",
  green: "bg-project-green",
  teal: "bg-project-teal",
  blue: "bg-project-blue",
  violet: "bg-project-violet",
  pink: "bg-project-pink",
};

export function ProjectLabel({
  name,
  icon,
  color,
  className,
}: {
  name: string;
  icon?: ProjectIcon | null;
  color?: ProjectColor | null;
  className?: string;
}) {
  return (
    <span
      className={cn("inline-flex items-center gap-1.5", color && COLOR_CLASS[color], className)}
    >
      {icon && <ProjectIconGlyph icon={icon} />}
      <span className="group-hover:underline">{name}</span>
    </span>
  );
}
