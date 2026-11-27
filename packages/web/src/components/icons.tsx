// Decorative SVG icons for the actions on a task; the button provides the accessible name.
import type { ProfileIcon, ProjectIcon } from "@lunasq/schemas";
import type { ComponentProps, ReactNode } from "react";

function Icon(props: ComponentProps<"svg"> & { name: string }) {
  const { name, children, ...rest } = props;
  return (
    <svg
      aria-hidden="true"
      data-icon={name}
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** Settings gear (outline, 18px like the header icons). */
export function SettingsIcon() {
  return (
    <Icon name="settings" width={18} height={18} fill="none">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </Icon>
  );
}

/** Plus sign (outline, 18px like the header icons). */
export function PlusIcon() {
  return (
    <Icon name="plus" width={18} height={18} fill="none">
      <path d="M12 5v14M5 12h14" />
    </Icon>
  );
}

/** Two vertical bars. */
export function PauseIcon() {
  return (
    <Icon name="pause">
      <rect x="6" y="4" width="4" height="16" rx="1" />
      <rect x="14" y="4" width="4" height="16" rx="1" />
    </Icon>
  );
}

/** Play triangle. */
export function ResumeIcon() {
  return (
    <Icon name="resume">
      <path d="M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5Z" />
    </Icon>
  );
}

// Outline glyphs for ProjectIcon (24px grid, drawn with the current color). Each key of the closed
// set has one; they are decorative, the project's name is always shown next to them.
const PROJECT_ICON_PATHS: Record<ProjectIcon, ReactNode> = {
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />,
  code: <path d="m16 18 6-6-6-6M8 6l-6 6 6 6" />,
  terminal: (
    <>
      <path d="m4 17 6-5-6-5" />
      <path d="M12 19h8" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5" />
      <path d="M3 12c0 1.7 4 3 9 3s9-1.3 9-3" />
    </>
  ),
  server: (
    <>
      <rect x="2" y="3" width="20" height="8" rx="2" />
      <rect x="2" y="13" width="20" height="8" rx="2" />
      <path d="M6 7h.01M6 17h.01" />
    </>
  ),
  rocket: (
    <>
      <path d="M4.5 16.5c-1.5 1.3-2 5-2 5s3.7-.5 5-2c.7-.8.7-2.1-.1-2.9a2.2 2.2 0 0 0-2.9-.1Z" />
      <path d="m12 15-3-3a22 22 0 0 1 2-3.9A12.9 12.9 0 0 1 22 2c0 2.7-.8 7.5-6 11a22.4 22.4 0 0 1-4 2Z" />
      <path d="M9 12H4s.6-3 2-4c1.6-1.1 5 0 5 0M12 15v5s3-.6 4-2c1.1-1.6 0-5 0-5" />
    </>
  ),
  book: (
    <>
      <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />
    </>
  ),
  package: (
    <>
      <path d="m7.5 4.3 9 5.2M21 8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4a2 2 0 0 0 1-1.7Z" />
      <path d="m3.3 7 8.7 5 8.7-5M12 22V12" />
    </>
  ),
  mobile: (
    <>
      <rect x="5" y="2" width="14" height="20" rx="2" />
      <path d="M12 18h.01" />
    </>
  ),
  cloud: <path d="M17.5 19H9a7 7 0 1 1 6.7-9h1.8a4.5 4.5 0 1 1 0 9Z" />,
  bolt: <path d="M13 2 3 14h9l-1 8 10-12h-9Z" />,
  pokeball: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h6.5M15.5 12H22" />
      <circle cx="12" cy="12" r="3.5" />
    </>
  ),
};

/** The glyph of a ProjectIcon key, decorative (aria-hidden) and drawn in the current text color. */
export function ProjectIconGlyph({ icon }: { icon: ProjectIcon }) {
  return (
    <Icon name={`project-${icon}`} fill="none" className="shrink-0">
      {PROJECT_ICON_PATHS[icon]}
    </Icon>
  );
}

// Outline glyphs of the agent profile icons (PROFILE_ICONS in @lunasq/schemas), drawn on a 24px grid.
const PROFILE_GLYPHS: Record<ProfileIcon, ReactNode> = {
  bot: (
    <>
      <rect x="4" y="8" width="16" height="12" rx="2" />
      <path d="M12 8V4M9 4h6M9 14h.01M15 14h.01" />
    </>
  ),
  sparkles: (
    <>
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
      <path d="M19 3v4M17 5h4" />
    </>
  ),
  bolt: <path d="M13 2L4 14h7l-1 8 9-12h-7z" />,
  brain: (
    <>
      <path d="M9.5 3A3.5 3.5 0 0 0 6 6.5 3.5 3.5 0 0 0 4 10a3.5 3.5 0 0 0 1.5 3A3.5 3.5 0 0 0 9 18.5V3z" />
      <path d="M14.5 3A3.5 3.5 0 0 1 18 6.5a3.5 3.5 0 0 1 2 3.5 3.5 3.5 0 0 1-1.5 3 3.5 3.5 0 0 1-3.5 5.5V3z" />
    </>
  ),
  rocket: (
    <>
      <path d="M5 19c-1 1-1.5 3-1.5 3s2-.5 3-1.5" />
      <path d="M12 15l-3-3a22 22 0 0 1 2-4 12 12 0 0 1 11-5c0 3-1 8-5 12a22 22 0 0 1-4 2z" />
      <path d="M9 12H4s.5-3 2-4c1.6-1 5 0 5 0M12 15v5s3-.5 4-2c1-1.6 0-5 0-5" />
    </>
  ),
  wrench: (
    <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.4 2.4-2.6-.6-.6-2.6z" />
  ),
  shield: <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />,
  flask: (
    <path d="M9 3h6M10 3v6L4.5 19a1.5 1.5 0 0 0 1.3 2h12.4a1.5 1.5 0 0 0 1.3-2L14 9V3M7.5 14h9" />
  ),
  compass: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M16 8l-2 6-6 2 2-6z" />
    </>
  ),
  leaf: (
    <>
      <path d="M5 19C5 10 11 4 20 4c0 9-6 15-15 15z" />
      <path d="M5 19l8-8" />
    </>
  ),
};

/** An agent profile's icon; decorative, whoever renders it provides the accessible name. */
export function ProfileGlyph({ icon, size = 12 }: { icon: ProfileIcon; size?: number }) {
  return (
    <Icon name={`profile-${icon}`} width={size} height={size} fill="none" strokeWidth={2}>
      {PROFILE_GLYPHS[icon]}
    </Icon>
  );
}

/** Neutral mark for a Run without a (known) profile: a dashed ring instead of an icon. */
export function NeutralGlyph({ size = 12 }: { size?: number }) {
  return (
    <Icon name="profile-neutral" width={size} height={size} fill="none" strokeWidth={2}>
      <circle cx="12" cy="12" r="9" strokeDasharray="4 3" />
    </Icon>
  );
}

// Navigation glyphs (outline, 16px): decorative, the link text names the page.
const NAV_GLYPHS = {
  queue: <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />,
  inProgress: <path d="M22 12h-4l-3 9L9 3l-3 9H2" />,
  completed: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12.5 2.5 2.5 4.5-5" />
    </>
  ),
  inbox: (
    <>
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z" />
    </>
  ),
  projects: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />,
  profiles: (
    <>
      <rect x="4" y="8" width="16" height="12" rx="2" />
      <path d="M12 8V4M9 4h6M9 14h.01M15 14h.01" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export function NavGlyph({ name }: { name: keyof typeof NAV_GLYPHS }) {
  return (
    <Icon
      name={`nav-${name}`}
      width={16}
      height={16}
      fill="none"
      className="shrink-0 opacity-70 group-aria-[current=page]:opacity-100"
    >
      {NAV_GLYPHS[name]}
    </Icon>
  );
}

/** Warning triangle for the global notices (16px, outline). */
export function WarningIcon() {
  return (
    <Icon name="warning" width={16} height={16} fill="none" className="shrink-0 text-warning-text">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
      <path d="M12 9v4M12 17h.01" />
    </Icon>
  );
}
