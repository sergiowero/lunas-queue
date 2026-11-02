import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
  // The theme and the language live in <html> and in localStorage, outside the tree that cleanup unmounts.
  localStorage.clear();
  document.documentElement.classList.remove("dark");
  document.documentElement.removeAttribute("lang");
});

// React Flow mide el DOM con APIs que jsdom no trae.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub;
globalThis.DOMMatrixReadOnly ??= class {
  m22 = 1;
} as unknown as typeof DOMMatrixReadOnly;

// jsdom no trae matchMedia: por defecto el sistema no declara esquema oscuro. Un test que quiera
// otro esquema usa stubColorScheme de test/render.tsx.
globalThis.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent: () => false,
})) as typeof matchMedia;
