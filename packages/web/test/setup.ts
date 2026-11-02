import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
  // The theme and the language live in <html> and in localStorage, outside the tree that cleanup unmounts.
  localStorage.clear();
  document.documentElement.classList.remove("dark");
  document.documentElement.removeAttribute("lang");
});

// React Flow measures the DOM with APIs that jsdom does not provide.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub;
globalThis.DOMMatrixReadOnly ??= class {
  m22 = 1;
} as unknown as typeof DOMMatrixReadOnly;

// jsdom has no matchMedia: by default the system declares no dark scheme. A test that wants
// another scheme uses stubColorScheme from test/render.tsx.
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
