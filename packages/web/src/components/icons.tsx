// Iconos SVG decorativos de las acciones sobre una tarea; el nombre accesible lo pone el botón.
import type { ComponentProps } from "react";

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

/** Dos barras verticales. */
export function PauseIcon() {
  return (
    <Icon name="pause">
      <rect x="6" y="4" width="4" height="16" rx="1" />
      <rect x="14" y="4" width="4" height="16" rx="1" />
    </Icon>
  );
}

/** Triángulo de reproducción. */
export function ResumeIcon() {
  return (
    <Icon name="resume">
      <path d="M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5Z" />
    </Icon>
  );
}
