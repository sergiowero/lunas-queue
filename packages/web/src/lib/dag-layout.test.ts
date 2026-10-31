import { describe, expect, it } from "vitest";
import { layoutGraph, NODE_HEIGHT, NODE_WIDTH } from "./dag-layout.ts";

const node = (id: string) => ({
  id,
  projectId: "p",
  intent: id,
  title: null,
  state: "draft" as const,
  subState: "queued" as const,
  prState: null,
  priority: 100,
});

describe("layoutGraph", () => {
  it("pone cada tarea a la derecha de aquello de lo que depende", () => {
    const laid = layoutGraph({
      nodes: [node("a"), node("b"), node("c")],
      edges: [
        { taskId: "b", dependsOnId: "a" },
        { taskId: "c", dependsOnId: "b" },
      ],
    });
    const x = Object.fromEntries(laid.nodes.map((n) => [n.id, n.position.x]));
    expect(x.a).toBeLessThan(x.b ?? Number.NaN);
    expect(x.b).toBeLessThan(x.c ?? Number.NaN);
  });

  it("dibuja la flecha de la dependencia hacia quien depende", () => {
    const laid = layoutGraph({
      nodes: [node("a"), node("b")],
      edges: [{ taskId: "b", dependsOnId: "a" }],
    });
    expect(laid.edges).toEqual([{ id: "a->b", source: "a", target: "b" }]);
  });

  it("no encima nodos de la misma capa y deja sueltas las tareas sin aristas", () => {
    const laid = layoutGraph({
      nodes: [node("a"), node("b"), node("c"), node("solo")],
      edges: [
        { taskId: "b", dependsOnId: "a" },
        { taskId: "c", dependsOnId: "a" },
      ],
    });
    expect(laid.nodes).toHaveLength(4);
    const boxes = laid.nodes.map((n) => n.position);
    for (const [i, p] of boxes.entries()) {
      for (const q of boxes.slice(i + 1)) {
        const overlap = Math.abs(p.x - q.x) < NODE_WIDTH && Math.abs(p.y - q.y) < NODE_HEIGHT;
        expect(overlap).toBe(false);
      }
    }
  });

  it("un grafo vacío no tiene nodos ni aristas", () => {
    expect(layoutGraph({ nodes: [], edges: [] })).toEqual({ nodes: [], edges: [] });
  });
});
