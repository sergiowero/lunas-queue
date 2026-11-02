import { describe, expect, it } from "vitest";
import { splitMentions } from "./mentions.ts";

describe("splitMentions", () => {
  it("splits the #N mentions from the surrounding text", () => {
    expect(splitMentions("depends on #5 and on #12.")).toEqual([
      "depends on ",
      { number: 5, text: "#5" },
      " and on ",
      { number: 12, text: "#12" },
      ".",
    ]);
  });

  it("recognizes a mention at the start, at the end and between punctuation", () => {
    expect(splitMentions("#3")).toEqual([{ number: 3, text: "#3" }]);
    expect(splitMentions("(#3)")).toEqual(["(", { number: 3, text: "#3" }, ")"]);
  });

  it("leaves as text what is not a mention: #abc, a#5, #5x, ## and #0", () => {
    for (const text of ["#abc", "a#5", "#5x", "##", "#0", "#", "sin menciones"]) {
      expect(splitMentions(text)).toEqual([text]);
    }
  });

  it("without text it returns an empty list", () => {
    expect(splitMentions("")).toEqual([]);
  });
});
