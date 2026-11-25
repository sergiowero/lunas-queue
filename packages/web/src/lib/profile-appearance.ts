// Presentation of an agent profile's color: one literal class string per color so Tailwind finds it.
// The tokens `--color-agent-<color>` and `-text` are defined for both themes in index.css.
import type { ProfileColor } from "@lunasq/schemas";

/** Chip classes: tinted fill, colored text and ring, like the Badge variants. */
export const PROFILE_COLOR_CLASSES: Record<ProfileColor, string> = {
  red: "bg-agent-red/10 text-agent-red-text ring-agent-red/20",
  orange: "bg-agent-orange/10 text-agent-orange-text ring-agent-orange/20",
  amber: "bg-agent-amber/10 text-agent-amber-text ring-agent-amber/20",
  green: "bg-agent-green/10 text-agent-green-text ring-agent-green/20",
  teal: "bg-agent-teal/10 text-agent-teal-text ring-agent-teal/20",
  blue: "bg-agent-blue/10 text-agent-blue-text ring-agent-blue/20",
  violet: "bg-agent-violet/10 text-agent-violet-text ring-agent-violet/20",
  pink: "bg-agent-pink/10 text-agent-pink-text ring-agent-pink/20",
};

/** Solid swatch of the color selector. */
export const PROFILE_COLOR_SWATCH: Record<ProfileColor, string> = {
  red: "bg-agent-red",
  orange: "bg-agent-orange",
  amber: "bg-agent-amber",
  green: "bg-agent-green",
  teal: "bg-agent-teal",
  blue: "bg-agent-blue",
  violet: "bg-agent-violet",
  pink: "bg-agent-pink",
};
