import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "../../test/render.tsx";

const PAGES = ["/queue", "/inbox", "/projects", "/tasks/new"];

async function settingsButton() {
  return screen.findByRole("link", { name: "Settings" });
}

describe("botón de Settings del header", () => {
  it.each(PAGES)("en %s, el nav de pestañas no contiene Settings", async (path) => {
    renderApp(path);
    await settingsButton();
    const nav = within(screen.getByRole("navigation"));
    expect(nav.queryByText("Settings")).toBeNull();
    expect(nav.queryByRole("link", { name: "Settings" })).toBeNull();
    for (const link of nav.getAllByRole("link")) {
      expect(link.getAttribute("href")).not.toBe("/settings");
    }
  });

  it.each(PAGES)(
    "en %s, es un enlace a /settings fuera del nav, sin texto visible y con un engrane decorativo",
    async (path) => {
      renderApp(path);
      const link = await settingsButton();
      expect(link.getAttribute("href")).toBe("/settings");
      expect(screen.getByRole("navigation").contains(link)).toBe(false);
      expect(link.textContent).toBe("");
      const svg = link.querySelector("svg");
      expect(svg?.getAttribute("aria-hidden")).toBe("true");
      expect(svg?.dataset.icon).toBe("settings");
    },
  );

  it("queda justo antes del selector de tema, que es el último elemento del header, y empuja a la derecha con ml-auto", async () => {
    renderApp("/queue");
    const link = await settingsButton();
    const theme = await screen.findByRole("button", { name: /^Cambiar a tema/ });
    expect(link.nextElementSibling).toBe(theme);
    expect(theme.parentElement?.lastElementChild).toBe(theme);
    expect(link.parentElement).toBe(theme.parentElement);
    expect(link.className).toContain("ml-auto");
  });

  it("un click desde /queue navega a /settings y muestra la página", async () => {
    const { user, router } = renderApp("/queue");
    const link = await settingsButton();
    expect(screen.getByRole("navigation").contains(link)).toBe(false);
    expect(link.getAttribute("title")).toBe("Settings");
    expect(link.querySelector("svg")?.dataset.icon).toBe("settings");
    await user.click(link);
    expect(router.state.location.pathname).toBe("/settings");
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeTruthy();
  });

  it("en /settings muestra el estado activo y ninguna pestaña del nav aparece activa", async () => {
    renderApp("/settings");
    const link = await settingsButton();
    expect(link.getAttribute("aria-current")).toBe("page");
    expect(link.className).toContain("bg-primary/10");
    expect(link.className).toContain("text-primary-text");
    const nav = within(screen.getByRole("navigation"));
    for (const tab of nav.getAllByRole("link")) {
      expect(tab.getAttribute("aria-current")).toBeNull();
    }
  });

  it("fuera de /settings no está activo", async () => {
    renderApp("/queue");
    const link = await settingsButton();
    expect(link.getAttribute("aria-current")).toBeNull();
  });

  it("muestra el tooltip nativo «Settings» y conserva el estilo del selector de tema", async () => {
    renderApp("/queue");
    const link = await settingsButton();
    expect(link.getAttribute("title")).toBe("Settings");
    expect(link.getAttribute("aria-label")).toBe("Settings");
    for (const cls of ["size-9", "rounded-lg", "hover:", "focus-visible:"]) {
      expect(link.className).toContain(cls);
    }
  });
});
