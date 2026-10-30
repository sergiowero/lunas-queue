import { describe, expect, it } from "vitest";
import { withTrailers } from "./trailers.ts";

describe("withTrailers", () => {
  it("agrega los trailers en su propio párrafo", () => {
    expect(withTrailers("feat: algo\n", { "LunasQ-Task": "t1", "LunasQ-Run": "r1" })).toBe(
      "feat: algo\n\nLunasQ-Task: t1\nLunasQ-Run: r1\n",
    );
  });

  it("conserva el cuerpo y no pega los trailers al asunto aunque tenga `: `", () => {
    expect(withTrailers("chore(x): algo\n\ncuerpo largo\n\n", { "LunasQ-Task": "t1" })).toBe(
      "chore(x): algo\n\ncuerpo largo\n\nLunasQ-Task: t1\n",
    );
  });

  it("suma a un bloque de trailers existente", () => {
    expect(
      withTrailers("fix: algo\n\nSigned-off-by: Ana <a@x.dev>\n", { "LunasQ-Task": "t1" }),
    ).toBe("fix: algo\n\nSigned-off-by: Ana <a@x.dev>\nLunasQ-Task: t1\n");
  });

  it("no repite una clave que el commit ya trae, aunque el valor sea otro", () => {
    const message = "fix: algo\n\nLunasQ-Task: t1\nLunasQ-Run: r1\n";
    expect(withTrailers(message, { "LunasQ-Task": "t1", "LunasQ-Run": "r2" })).toBe(message);
  });

  it("completa solo la clave que falta", () => {
    expect(
      withTrailers("fix: algo\n\nLunasQ-Task: t1\n", { "LunasQ-Task": "t1", "LunasQ-Run": "r1" }),
    ).toBe("fix: algo\n\nLunasQ-Task: t1\nLunasQ-Run: r1\n");
  });

  it("sin trailers devuelve el mensaje tal cual", () => {
    expect(withTrailers("fix: algo\n", {})).toBe("fix: algo\n");
  });
});
