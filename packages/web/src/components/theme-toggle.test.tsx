import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderApp, stubColorScheme } from "../../test/render.tsx";
import { THEME_KEY } from "../lib/theme.ts";

const html = document.documentElement;

function toggle() {
  return screen.getByRole("button", { name: /^Cambiar a tema/ });
}

function icon() {
  return toggle().querySelector("svg")?.dataset.icon;
}

describe("selector de tema", () => {
  it.each(["/queue", "/inbox", "/projects", "/tasks/new"])(
    "en %s, sin preferencia y con el sistema en claro, el tema es claro y el selector al final del header muestra la luna",
    async (path) => {
      stubColorScheme("light");
      renderApp(path);
      const button = await screen.findByRole("button", { name: "Cambiar a tema oscuro" });
      expect(html.classList.contains("dark")).toBe(false);
      expect(icon()).toBe("moon");
      const bar = button.parentElement;
      expect(bar?.parentElement?.tagName).toBe("HEADER");
      expect(bar?.lastElementChild).toBe(button);
      expect(button.className).toContain("ml-auto");
    },
  );

  it("en tema claro, un click pasa a oscuro, muestra el sol y guarda «dark»", async () => {
    const { user } = renderApp("/queue");
    await user.click(await screen.findByRole("button", { name: "Cambiar a tema oscuro" }));
    expect(html.classList.contains("dark")).toBe(true);
    expect(icon()).toBe("sun");
    expect(toggle().getAttribute("aria-label")).toBe("Cambiar a tema claro");
    expect(localStorage.getItem(THEME_KEY)).toBe("dark");
  });

  it("en tema oscuro, un click pasa a claro, muestra la luna y guarda «light»", async () => {
    localStorage.setItem(THEME_KEY, "dark");
    const { user } = renderApp("/queue");
    await user.click(await screen.findByRole("button", { name: "Cambiar a tema claro" }));
    expect(html.classList.contains("dark")).toBe(false);
    expect(icon()).toBe("moon");
    expect(localStorage.getItem(THEME_KEY)).toBe("light");
  });

  it("con «dark» guardado, al cargar el tema es oscuro y muestra el sol aunque el sistema esté en claro", async () => {
    stubColorScheme("light");
    localStorage.setItem(THEME_KEY, "dark");
    renderApp("/queue");
    await screen.findByRole("button", { name: "Cambiar a tema claro" });
    expect(html.classList.contains("dark")).toBe(true);
    expect(icon()).toBe("sun");
  });

  it("sin preferencia guardada y con el sistema en oscuro, al cargar el tema es oscuro", async () => {
    stubColorScheme("dark");
    renderApp("/queue");
    await screen.findByRole("button", { name: "Cambiar a tema claro" });
    expect(html.classList.contains("dark")).toBe(true);
  });

  it("con un valor guardado inválido, carga en claro y el selector sigue alternando", async () => {
    localStorage.setItem(THEME_KEY, "sepia");
    const { user } = renderApp("/queue");
    await user.click(await screen.findByRole("button", { name: "Cambiar a tema oscuro" }));
    expect(html.classList.contains("dark")).toBe(true);
    await user.click(toggle());
    expect(html.classList.contains("dark")).toBe(false);
  });

  it("con localStorage que lanza error y sin matchMedia, carga en claro y el selector sigue alternando", async () => {
    vi.stubGlobal("matchMedia", undefined);
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("SecurityError");
      },
      clear: () => {},
    });
    const { user } = renderApp("/queue");
    await user.click(await screen.findByRole("button", { name: "Cambiar a tema oscuro" }));
    expect(html.classList.contains("dark")).toBe(true);
    expect(icon()).toBe("sun");
    await user.click(toggle());
    expect(icon()).toBe("moon");
  });

  it("es un botón con aria-label de la acción, icono decorativo y operable con teclado", async () => {
    const { user } = renderApp("/queue");
    const button = await screen.findByRole("button", { name: "Cambiar a tema oscuro" });
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("type")).toBe("button");
    expect(button.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");

    button.focus();
    await user.keyboard("{Enter}");
    expect(html.classList.contains("dark")).toBe(true);
    expect(button.getAttribute("aria-label")).toBe("Cambiar a tema claro");
    await user.keyboard(" ");
    expect(html.classList.contains("dark")).toBe(false);
    expect(button.getAttribute("aria-label")).toBe("Cambiar a tema oscuro");
  });
});
