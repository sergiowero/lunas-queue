import { describe, expect, it } from "vitest";
import { splitMentions } from "./mentions.ts";

describe("splitMentions", () => {
  it("separa las menciones #N del texto que las rodea", () => {
    expect(splitMentions("depende de #5 y de #12.")).toEqual([
      "depende de ",
      { number: 5, text: "#5" },
      " y de ",
      { number: 12, text: "#12" },
      ".",
    ]);
  });

  it("reconoce una mención al inicio, al final y entre signos", () => {
    expect(splitMentions("#3")).toEqual([{ number: 3, text: "#3" }]);
    expect(splitMentions("(#3)")).toEqual(["(", { number: 3, text: "#3" }, ")"]);
  });

  it("deja como texto lo que no es una mención: #abc, a#5, #5x, ## y #0", () => {
    for (const text of ["#abc", "a#5", "#5x", "##", "#0", "#", "sin menciones"]) {
      expect(splitMentions(text)).toEqual([text]);
    }
  });

  it("sin texto devuelve una lista vacía", () => {
    expect(splitMentions("")).toEqual([]);
  });
});
