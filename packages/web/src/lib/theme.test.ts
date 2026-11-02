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

describe("resolve the theme", () => {
  it("without a saved preference and with the system light, the theme is light", () => {
    stubColorScheme("light");
    expect(resolveTheme()).toBe("light");
  });

  it("the saved preference «dark» wins even if the system is light", () => {
    stubColorScheme("light");
    localStorage.setItem(THEME_KEY, "dark");
    expect(resolveTheme()).toBe("dark");
  });

  it("the saved preference «light» wins even if the system is dark", () => {
    stubColorScheme("dark");
    localStorage.setItem(THEME_KEY, "light");
    expect(resolveTheme()).toBe("light");
  });

  it("without a saved preference and with the system dark, the theme is dark", () => {
    stubColorScheme("dark");
    expect(resolveTheme()).toBe("dark");
  });

  it("an invalid saved value is ignored and falls back to the system preference", () => {
    localStorage.setItem(THEME_KEY, "sepia");
    expect(resolveTheme()).toBe("light");
    stubColorScheme("dark");
    expect(resolveTheme()).toBe("dark");
  });

  it("a localStorage that throws does not break: it uses the light theme", () => {
    brokenStorage();
    expect(resolveTheme()).toBe("light");
  });

  it("without matchMedia in the environment, the default theme is light", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(resolveTheme()).toBe("light");
  });
});

describe("apply the theme", () => {
  it("on load, it applies the resolved theme to <html> without saving it", () => {
    stubColorScheme("dark");
    initTheme();
    expect(html.classList.contains("dark")).toBe(true);
    expect(currentTheme()).toBe("dark");
    expect(localStorage.getItem(THEME_KEY)).toBeNull();
  });

  it("switching to dark sets the dark class and saves «dark»", () => {
    setTheme("dark");
    expect(html.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem(THEME_KEY)).toBe("dark");
  });

  it("switching to light removes the dark class and saves «light»", () => {
    setTheme("dark");
    setTheme("light");
    expect(html.classList.contains("dark")).toBe(false);
    expect(currentTheme()).toBe("light");
    expect(localStorage.getItem(THEME_KEY)).toBe("light");
  });

  it("with a localStorage that throws, the theme change is applied anyway", () => {
    brokenStorage();
    setTheme("dark");
    expect(currentTheme()).toBe("dark");
  });
});

describe("theme change animation", () => {
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

  it("with View Transitions, it reveals the new theme with a circle that grows from the origin", async () => {
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

  it("if the theme does not change or reduced motion is preferred, it applies without animation", () => {
    const { start } = stubViewTransition();
    setTheme("light");
    expect(start).not.toHaveBeenCalled();

    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduced-motion") }));
    setTheme("dark");
    expect(start).not.toHaveBeenCalled();
    expect(html.classList.contains("dark")).toBe(true);
  });

  it("without View Transitions, it fades the colors with a temporary class", () => {
    vi.useFakeTimers();
    setTheme("dark");
    expect(html.classList.contains("dark")).toBe(true);
    expect(html.classList.contains("theme-transition")).toBe(true);
    vi.advanceTimersByTime(320);
    expect(html.classList.contains("theme-transition")).toBe(false);
  });
});
