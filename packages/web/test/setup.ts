import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => cleanup());

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
