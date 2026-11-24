import { PROJECT_COLORS, PROJECT_ICONS } from "@lunasq/schemas";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProjectLabel } from "./project-label.tsx";

const projectColorClass = (el: HTMLElement) =>
  [...el.classList].filter((c) => c.startsWith("text-project-"));

describe("ProjectLabel", () => {
  it("with icon and color shows the aria-hidden icon and the name in the color's token", () => {
    const { container } = render(<ProjectLabel name="lunas-queue" icon="rocket" color="teal" />);
    const icon = container.querySelector("svg");
    expect(icon?.getAttribute("data-icon")).toBe("project-rocket");
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    // The color is on the label that holds both the icon and the name.
    expect(projectColorClass(container.firstElementChild as HTMLElement)).toEqual([
      "text-project-teal",
    ]);
    expect(container.firstElementChild?.contains(screen.getByText("lunas-queue"))).toBe(true);
  });

  it("without icon and without color shows only the name, with the default text color", () => {
    const { container } = render(<ProjectLabel name="lunas-queue" icon={null} color={null} />);
    expect(container.querySelector("svg")).toBeNull();
    expect(screen.getByText("lunas-queue")).toBeTruthy();
    expect(container.innerHTML).not.toMatch(/text-project-/);
  });

  it("treats missing props like null", () => {
    const { container } = render(<ProjectLabel name="lunas-queue" />);
    expect(container.querySelector("svg")).toBeNull();
    expect(container.innerHTML).not.toMatch(/text-project-/);
  });

  it("with a color but no icon tints the name and draws no icon", () => {
    const { container } = render(<ProjectLabel name="lunas-queue" color="violet" />);
    expect(container.querySelector("svg")).toBeNull();
    expect(container.innerHTML).toContain("text-project-violet");
    expect(screen.getByText("lunas-queue")).toBeTruthy();
  });

  it("with an icon but no color draws the icon and applies no color", () => {
    const { container } = render(<ProjectLabel name="lunas-queue" icon="database" />);
    expect(container.querySelector("svg")?.getAttribute("data-icon")).toBe("project-database");
    expect(container.innerHTML).not.toMatch(/text-project-/);
    expect(screen.getByText("lunas-queue")).toBeTruthy();
  });

  it("the accessible name is the project name, without the decorative icon", () => {
    const { container } = render(<ProjectLabel name="lunas-queue" icon="rocket" color="teal" />);
    expect(container.textContent).toBe("lunas-queue");
  });

  it.each(PROJECT_ICONS)("draws the %s icon", (icon) => {
    const { container } = render(<ProjectLabel name="p" icon={icon} />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("data-icon")).toBe(`project-${icon}`);
    expect(svg?.childElementCount).toBeGreaterThan(0);
  });

  it.each(PROJECT_COLORS)("tints the name with the %s token", (color) => {
    const { container } = render(<ProjectLabel name="p" color={color} />);
    expect(container.innerHTML).toContain(`text-project-${color}`);
  });
});
