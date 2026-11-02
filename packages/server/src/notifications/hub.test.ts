import type { Notification } from "@lunasq/schemas";
import { describe, expect, it } from "vitest";
import { NotificationHub } from "./hub.ts";
import { notification } from "./test-helpers.ts";

describe("NotificationHub", () => {
  it("delivers each publication to all subscribers", () => {
    const hub = new NotificationHub();
    const a: Notification[] = [];
    const b: Notification[] = [];
    hub.subscribe((n) => a.push(n));
    hub.subscribe((n) => b.push(n));
    hub.publish(notification());
    expect(a.map((n) => n.id)).toEqual(["question:q-1"]);
    expect(b.map((n) => n.id)).toEqual(["question:q-1"]);
  });

  it("a new subscriber without lastEventId does not receive what came before", () => {
    const hub = new NotificationHub();
    hub.publish(notification());
    const got: Notification[] = [];
    hub.subscribe((n) => got.push(n));
    expect(got).toEqual([]);
  });

  it("with lastEventId it resends only what was published after", () => {
    const hub = new NotificationHub();
    hub.publish(notification({ id: "n:1" }));
    hub.publish(notification({ id: "n:2" }));
    hub.publish(notification({ id: "n:3" }));
    const got: string[] = [];
    hub.subscribe((n) => got.push(n.id), { lastEventId: "n:2" });
    expect(got).toEqual(["n:3"]);
  });

  it("if the lastEventId already left the buffer, everything remaining is later and is resent", () => {
    const hub = new NotificationHub({ bufferSize: 2 });
    for (const id of ["n:1", "n:2", "n:3", "n:4"]) hub.publish(notification({ id }));
    const got: string[] = [];
    hub.subscribe((n) => got.push(n.id), { lastEventId: "n:1" });
    expect(got).toEqual(["n:3", "n:4"]);
  });

  it("with a repeated id in the buffer it resumes from the last copy", () => {
    const hub = new NotificationHub();
    for (const id of ["n:1", "n:2", "n:1", "n:3"]) hub.publish(notification({ id }));
    const got: string[] = [];
    hub.subscribe((n) => got.push(n.id), { lastEventId: "n:1" });
    expect(got).toEqual(["n:3"]);
  });

  it("an empty lastEventId is equivalent to not providing it", () => {
    const hub = new NotificationHub();
    hub.publish(notification());
    const got: Notification[] = [];
    hub.subscribe((n) => got.push(n), { lastEventId: "" });
    expect(got).toEqual([]);
  });

  it("on unsubscribing it stops receiving", () => {
    const hub = new NotificationHub();
    const got: Notification[] = [];
    const unsubscribe = hub.subscribe((n) => got.push(n));
    unsubscribe();
    hub.publish(notification());
    expect(got).toEqual([]);
    expect(hub.subscriberCount).toBe(0);
  });

  it("a failing subscriber does not prevent delivery to the others", () => {
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
