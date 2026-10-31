import { describe, expect, it, vi } from "vitest";
import { stubColorScheme } from "../../test/render.tsx";
import { currentTheme, initTheme, resolveTheme, setTheme, THEME_KEY } from "./theme.ts";

const html = document.documentElement;

function brokenStorage() {
  vi.stubGlobal("localStorage", {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
  });
}

describe("resolver el tema", () => {
  it("sin preferencia guardada y con el sistema en claro, el tema es claro", () => {
    stubColorScheme("light");
    expect(resolveTheme()).toBe("light");
  });

  it("la preferencia guardada «dark» gana aunque el sistema esté en claro", () => {
    stubColorScheme("light");
    localStorage.setItem(THEME_KEY, "dark");
    expect(resolveTheme()).toBe("dark");
  });

  it("la preferencia guardada «light» gana aunque el sistema esté en oscuro", () => {
    stubColorScheme("dark");
    localStorage.setItem(THEME_KEY, "light");
    expect(resolveTheme()).toBe("light");
  });

  it("sin preferencia guardada y con el sistema en oscuro, el tema es oscuro", () => {
    stubColorScheme("dark");
    expect(resolveTheme()).toBe("dark");
  });

  it("un valor guardado inválido se ignora y cae a la preferencia del sistema", () => {
    localStorage.setItem(THEME_KEY, "sepia");
    expect(resolveTheme()).toBe("light");
    stubColorScheme("dark");
    expect(resolveTheme()).toBe("dark");
  });

  it("un localStorage que lanza error no rompe: usa el tema claro", () => {
    brokenStorage();
    expect(resolveTheme()).toBe("light");
  });

  it("sin matchMedia en el entorno, el tema por defecto es claro", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(resolveTheme()).toBe("light");
  });
});

describe("aplicar el tema", () => {
  it("al cargar, aplica el tema resuelto en <html> sin guardarlo", () => {
    stubColorScheme("dark");
    initTheme();
    expect(html.classList.contains("dark")).toBe(true);
    expect(currentTheme()).toBe("dark");
    expect(localStorage.getItem(THEME_KEY)).toBeNull();
  });

  it("cambiar a oscuro pone la clase dark y guarda «dark»", () => {
    setTheme("dark");
    expect(html.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem(THEME_KEY)).toBe("dark");
  });

  it("cambiar a claro quita la clase dark y guarda «light»", () => {
    setTheme("dark");
    setTheme("light");
    expect(html.classList.contains("dark")).toBe(false);
    expect(currentTheme()).toBe("light");
    expect(localStorage.getItem(THEME_KEY)).toBe("light");
  });

  it("con un localStorage que lanza error, el cambio de tema se aplica igual", () => {
    brokenStorage();
    setTheme("dark");
    expect(currentTheme()).toBe("dark");
  });
});
