import { describe, expect, it } from "vitest";
import { KeyedLock } from "./keyed-lock.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

describe("KeyedLock", () => {
  it("serializa la misma clave y deja correr claves distintas en paralelo", async () => {
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

  it("un fallo no bloquea a la siguiente y se propaga a quien la pidió", async () => {
    const lock = new KeyedLock();
    const failing = lock.run("a", async () => {
      throw new Error("boom");
    });
    const next = lock.run("a", async () => "ok");
    await expect(failing).rejects.toThrow("boom");
    await expect(next).resolves.toBe("ok");
  });
});
