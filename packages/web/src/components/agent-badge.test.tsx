import { PROFILE_COLORS, PROFILE_ICONS } from "@lunasq/schemas";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FakeApi } from "../../test/fake-api.ts";
import { renderApp } from "../../test/render.tsx";
import { LANGUAGE_KEY } from "../lib/i18n.ts";
import { PROFILE_COLOR_CLASSES } from "../lib/profile-appearance.ts";

describe("agent badge", () => {
  it("shows the profile's icon, color and name, with an accessible name that includes the profile", async () => {
    const fake = new FakeApi();
    fake.addProfile({ name: "Rápido", icon: "rocket", color: "violet" });
    renderApp("/profiles", fake);

    const badge = await screen.findByRole("img", { name: "Agente Rápido" });
    expect(badge.getAttribute("data-icon")).toBe("rocket");
    expect(badge.getAttribute("data-color")).toBe("violet");
    expect(badge.className).toContain("text-agent-violet-text");
    expect(badge.querySelector('[data-icon="profile-rocket"]')).not.toBeNull();
    expect(badge.textContent).toContain("Rápido");
  });

  it("takes its accessible name from the active language", async () => {
    localStorage.setItem(LANGUAGE_KEY, "en");
    try {
      const fake = new FakeApi();
      fake.addProfile({ name: "Fast", icon: "bolt", color: "teal" });
      renderApp("/profiles", fake);
      expect(await screen.findByRole("img", { name: "Agent Fast" })).toBeTruthy();
    } finally {
      localStorage.removeItem(LANGUAGE_KEY);
    }
  });

  it("every icon and color of the sets has a glyph and a class", () => {
    for (const color of PROFILE_COLORS)
      expect(PROFILE_COLOR_CLASSES[color]).toContain(`agent-${color}`);
    expect(PROFILE_ICONS.length).toBeGreaterThan(0);
  });
});
