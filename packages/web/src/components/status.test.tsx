import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StateBadges } from "./status.tsx";

describe("etiqueta de estado", () => {
  it("una tarea In progress lleva la etiqueta azul info con su sub-estado", () => {
    render(<StateBadges state="in_progress" subState="running" />);
    const label = screen.getByText("In progress");
    expect(label.dataset.variant).toBe("info");
    expect(label.className).toContain("bg-info");
    expect(screen.getByText("corriendo").dataset.variant).toBe("outline");
  });

  it("los demás estados no se pintan de azul y Needs human sigue en destructive", () => {
    render(
      <>
        <StateBadges state="draft" subState="queued" />
        <StateBadges state="verification" subState="running" />
        <StateBadges state="needs_human" subState={null} />
        <StateBadges state="completed" subState={null} />
      </>,
    );
    expect(screen.getByText("Draft").dataset.variant).toBe("secondary");
    expect(screen.getByText("Verification").dataset.variant).toBe("secondary");
    expect(screen.getByText("Completed").dataset.variant).toBe("secondary");
    expect(screen.getByText("Needs human").dataset.variant).toBe("destructive");
  });
});
