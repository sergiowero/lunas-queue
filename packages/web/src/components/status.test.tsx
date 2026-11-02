import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StateBadges } from "./status.tsx";

describe("status label", () => {
  it("an In progress task carries the blue info label with its sub-state", () => {
    render(<StateBadges state="in_progress" subState="running" />);
    const label = screen.getByText("In progress");
    expect(label.dataset.variant).toBe("info");
    expect(label.className).toContain("bg-info");
    expect(screen.getByText("corriendo").dataset.variant).toBe("outline");
  });

  it("the other states are not painted blue and Needs human stays destructive", () => {
    render(
      <>
        <StateBadges state="draft" subState="queued" />
        <StateBadges state="verification" subState="running" />
        <StateBadges state="needs_human" subState={null} />
        <StateBadges state="completed" subState={null} />
        <StateBadges state="paused" subState={null} />
      </>,
    );
    expect(screen.getByText("Paused").dataset.variant).toBe("secondary");
    expect(screen.getByText("Draft").dataset.variant).toBe("secondary");
    expect(screen.getByText("Verification").dataset.variant).toBe("secondary");
    expect(screen.getByText("Completed").dataset.variant).toBe("secondary");
    expect(screen.getByText("Needs human").dataset.variant).toBe("destructive");
  });
});
