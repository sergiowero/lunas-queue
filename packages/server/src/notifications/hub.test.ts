import type { Notification } from "@lunasq/schemas";
import { describe, expect, it } from "vitest";
import { NotificationHub } from "./hub.ts";
import { notification } from "./test-helpers.ts";

describe("NotificationHub", () => {
  it("entrega cada publicación a todos los suscriptores", () => {
    const hub = new NotificationHub();
    const a: Notification[] = [];
    const b: Notification[] = [];
    hub.subscribe((n) => a.push(n));
    hub.subscribe((n) => b.push(n));
    hub.publish(notification());
    expect(a.map((n) => n.id)).toEqual(["question:q-1"]);
    expect(b.map((n) => n.id)).toEqual(["question:q-1"]);
  });

  it("un suscriptor nuevo sin lastEventId no recibe lo anterior", () => {
    const hub = new NotificationHub();
    hub.publish(notification());
    const got: Notification[] = [];
    hub.subscribe((n) => got.push(n));
    expect(got).toEqual([]);
  });

  it("con lastEventId reenvía solo lo publicado después", () => {
    const hub = new NotificationHub();
    hub.publish(notification({ id: "n:1" }));
    hub.publish(notification({ id: "n:2" }));
    hub.publish(notification({ id: "n:3" }));
    const got: string[] = [];
    hub.subscribe((n) => got.push(n.id), { lastEventId: "n:2" });
    expect(got).toEqual(["n:3"]);
  });

  it("si el lastEventId ya salió del buffer, todo lo que queda es posterior y se reenvía", () => {
    const hub = new NotificationHub({ bufferSize: 2 });
    for (const id of ["n:1", "n:2", "n:3", "n:4"]) hub.publish(notification({ id }));
    const got: string[] = [];
    hub.subscribe((n) => got.push(n.id), { lastEventId: "n:1" });
    expect(got).toEqual(["n:3", "n:4"]);
  });

  it("con un id repetido en el buffer reanuda desde la última copia", () => {
    const hub = new NotificationHub();
    for (const id of ["n:1", "n:2", "n:1", "n:3"]) hub.publish(notification({ id }));
    const got: string[] = [];
    hub.subscribe((n) => got.push(n.id), { lastEventId: "n:1" });
    expect(got).toEqual(["n:3"]);
  });

  it("un lastEventId vacío equivale a no traerlo", () => {
    const hub = new NotificationHub();
    hub.publish(notification());
    const got: Notification[] = [];
    hub.subscribe((n) => got.push(n), { lastEventId: "" });
    expect(got).toEqual([]);
  });

  it("al desuscribirse deja de recibir", () => {
    const hub = new NotificationHub();
    const got: Notification[] = [];
    const unsubscribe = hub.subscribe((n) => got.push(n));
    unsubscribe();
    hub.publish(notification());
    expect(got).toEqual([]);
    expect(hub.subscriberCount).toBe(0);
  });

  it("un suscriptor que falla no impide la entrega a los demás", () => {
    const hub = new NotificationHub();
    const got: Notification[] = [];
    hub.subscribe(() => {
      throw new Error("roto");
    });
    hub.subscribe((n) => got.push(n));
    hub.publish(notification());
    expect(got).toHaveLength(1);
  });
});
