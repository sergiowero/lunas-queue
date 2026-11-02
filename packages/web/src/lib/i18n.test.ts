import { afterEach, describe, expect, it, vi } from "vitest";
import {
  currentLanguage,
  initLanguage,
  LANGUAGE_KEY,
  resolveLanguage,
  setLanguage,
} from "./i18n.ts";

const html = document.documentElement;

afterEach(() => vi.unstubAllGlobals());

describe("language resolution", () => {
  it("without a stored preference the language is Spanish", () => {
    expect(resolveLanguage()).toBe("es");
    expect(currentLanguage()).toBe("es");
  });

  it("a stored valid preference wins", () => {
    localStorage.setItem(LANGUAGE_KEY, "en");
    expect(resolveLanguage()).toBe("en");
    expect(currentLanguage()).toBe("en");
  });

  it("an invalid stored value is ignored", () => {
    localStorage.setItem(LANGUAGE_KEY, "fr");
    expect(resolveLanguage()).toBe("es");
  });

  it("a localStorage that throws falls back to Spanish without failing", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("SecurityError");
      },
    });
    expect(resolveLanguage()).toBe("es");
    expect(() => setLanguage("en")).not.toThrow();
    expect(currentLanguage()).toBe("en");
  });

  it("initLanguage applies the language to <html> without saving it", () => {
    localStorage.setItem(LANGUAGE_KEY, "en");
    initLanguage();
    expect(html.lang).toBe("en");
    localStorage.clear();
    initLanguage();
    expect(html.lang).toBe("es");
    expect(localStorage.getItem(LANGUAGE_KEY)).toBeNull();
  });

  it("setLanguage updates <html lang> and remembers the choice", () => {
    setLanguage("en");
    expect(html.lang).toBe("en");
    expect(localStorage.getItem(LANGUAGE_KEY)).toBe("en");
    setLanguage("es");
    expect(html.lang).toBe("es");
    expect(localStorage.getItem(LANGUAGE_KEY)).toBe("es");
  });
});
