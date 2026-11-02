import { describe, expect, it } from "vitest";
import { KeyedLock } from "./keyed-lock.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

describe("KeyedLock", () => {
  it("serializes the same key and lets different keys run in parallel", async () => {
    const lock = new KeyedLock();
    const log: string[] = [];
    const job = (name: string) => async () => {
      log.push(`${name}:start`);
      await tick();
      log.push(`${name}:end`);
    };
    await Promise.all([
      lock.run("a", job("a1")),
      lock.run("a", job("a2")),
      lock.run("b", job("b1")),
    ]);
    expect(log.indexOf("a1:end")).toBeLessThan(log.indexOf("a2:start"));
    expect(log.indexOf("b1:start")).toBeLessThan(log.indexOf("a1:end"));
  });

  it("a failure does not block the next one and propagates to whoever requested it", async () => {
    const lock = new KeyedLock();
    const failing = lock.run("a", async () => {
      throw new Error("boom");
    });
    const next = lock.run("a", async () => "ok");
    await expect(failing).rejects.toThrow("boom");
    await expect(next).resolves.toBe("ok");
  });
});
