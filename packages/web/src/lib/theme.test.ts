import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("animación del cambio de tema", () => {
  function stubViewTransition() {
    const start = vi.fn((update: () => void) => {
      update();
      return { ready: Promise.resolve() };
    });
    const animate = vi.fn();
    // jsdom no implementa View Transitions ni Web Animations.
    Object.defineProperty(document, "startViewTransition", { value: start, configurable: true });
    Object.defineProperty(html, "animate", { value: animate, configurable: true });
    return { start, animate };
  }

  afterEach(() => {
    Reflect.deleteProperty(document, "startViewTransition");
    Reflect.deleteProperty(html, "animate");
    vi.useRealTimers();
  });

  it("con View Transitions, revela el tema nuevo con un círculo que crece desde el origen", async () => {
    const { start, animate } = stubViewTransition();
    setTheme("dark", { x: 10, y: 20 });
    expect(start).toHaveBeenCalledOnce();
    expect(html.classList.contains("dark")).toBe(true);
    await Promise.resolve();
    expect(animate).toHaveBeenCalledOnce();
    const [keyframes, options] = animate.mock.calls[0] ?? [];
    const at = `at ${(10 / innerWidth) * 100}% ${(20 / innerHeight) * 100}%`;
    expect(keyframes.clipPath[0]).toBe(`circle(0% ${at})`);
    expect(keyframes.clipPath[1]).toMatch(
      new RegExp(`^circle\\([\\d.]+% ${at.replace(/\./g, "\\.")}\\)$`),
    );
    expect(options.pseudoElement).toBe("::view-transition-new(root)");
  });

  it("si el tema no cambia o se prefiere menos movimiento, se aplica sin animación", () => {
    const { start } = stubViewTransition();
    setTheme("light");
    expect(start).not.toHaveBeenCalled();

    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduced-motion") }));
    setTheme("dark");
    expect(start).not.toHaveBeenCalled();
    expect(html.classList.contains("dark")).toBe(true);
  });

  it("sin View Transitions, funde los colores con una clase temporal", () => {
    vi.useFakeTimers();
    setTheme("dark");
    expect(html.classList.contains("dark")).toBe(true);
    expect(html.classList.contains("theme-transition")).toBe(true);
    vi.advanceTimersByTime(320);
    expect(html.classList.contains("theme-transition")).toBe(false);
  });
});
