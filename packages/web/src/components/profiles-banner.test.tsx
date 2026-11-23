import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FakeApi } from "../../test/fake-api.ts";
import { renderApp } from "../../test/render.tsx";
import { LANGUAGE_KEY } from "../lib/i18n.ts";

// A fresh object per project: a test mutates it to simulate another tab assigning profiles.
const unassignedPhases = () => ({ refine: null, implement: null, verify: null, deliver: null });

describe("banner for phases without a profile", () => {
  it("appears on any page while a project has an unassigned phase, with a link to Projects", async () => {
    const fake = new FakeApi();
    fake.addProject({ name: "sin-perfil", agentProfiles: unassignedPhases() });
    renderApp("/queue", fake);

    const banner = await screen.findByText("Fases sin perfil:");
    expect(banner.closest("[role=status]")?.textContent).toContain(
      "1 proyecto tiene fases sin perfil de agente",
    );
    expect(screen.getByRole("link", { name: "Ir a Proyectos" }).getAttribute("href")).toBe(
      "/projects",
    );
  });

  it("counts the affected projects and is absent when every phase has a profile", async () => {
    const fake = new FakeApi();
    fake.addProject({ name: "completo" });
    fake.addProject({ name: "a", agentProfiles: unassignedPhases() });
    fake.addProject({
      name: "b",
      agentProfiles: { ...unassignedPhases(), verify: fake.defaultProfile().id },
    });
    renderApp("/queue", fake);
    expect(
      (await screen.findByText(/2 proyectos tienen fases sin perfil/)).textContent,
    ).toBeTruthy();
  });

  it("is not shown when all projects are fully assigned", async () => {
    const fake = new FakeApi();
    fake.addProject({ name: "completo" });
    renderApp("/projects", fake);
    await screen.findByRole("link", { name: "completo" });
    expect(screen.queryByText("Fases sin perfil:")).toBeNull();
  });

  it("disappears once the missing profile is assigned", async () => {
    const fake = new FakeApi();
    const profile = fake.addProfile({ name: "Rápido" });
    const project = fake.addProject({ name: "a", agentProfiles: unassignedPhases() });
    const app = renderApp("/queue", fake);
    await screen.findByText("Fases sin perfil:");

    Object.assign(project.agentProfiles, {
      refine: profile.id,
      implement: profile.id,
      verify: profile.id,
      deliver: profile.id,
    });
    await app.refresh();

    await waitFor(() => expect(screen.queryByText("Fases sin perfil:")).toBeNull());
  });

  it("speaks English", async () => {
    localStorage.setItem(LANGUAGE_KEY, "en");
    const fake = new FakeApi();
    fake.addProject({ name: "a", agentProfiles: unassignedPhases() });
    renderApp("/queue", fake);
    expect(await screen.findByText("Phases without a profile:")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go to Projects" })).toBeTruthy();
  });
});
