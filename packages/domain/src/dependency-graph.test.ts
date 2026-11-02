import { describe, expect, it } from "vitest";
import {
  type DependencyEdge,
  DependencyGraph,
  InMemoryDependencyGraphReader,
} from "./dependency-graph.ts";
import { dependencyGraphReaderContract } from "./testing.ts";

const edge = (taskId: string, dependsOnId: string): DependencyEdge => ({ taskId, dependsOnId });

// d depends on b and c; b and c depend on a; e depends on d.  a ← b,c ← d ← e
const diamond = [edge("b", "a"), edge("c", "a"), edge("d", "b"), edge("d", "c"), edge("e", "d")];

describe("DependencyGraph", () => {
  it("exposes direct dependencies and dependents", () => {
    const graph = DependencyGraph.from(diamond);
    expect(graph.dependenciesOf("d")).toEqual(["b", "c"]);
    expect(graph.dependentsOf("a")).toEqual(["b", "c"]);
    expect(graph.dependenciesOf("a")).toEqual([]);
    expect(graph.dependentsOf("desconocida")).toEqual([]);
  });

  it("ancestors: every task it depends on, by distance and without repeats", () => {
    const graph = DependencyGraph.from(diamond);
    expect(graph.ancestors("e")).toEqual(["d", "b", "c", "a"]);
    expect(graph.ancestors("a")).toEqual([]);
  });

  it("descendants: every task it blocks, by distance and without repeats", () => {
    const graph = DependencyGraph.from(diamond);
    expect(graph.descendants("a")).toEqual(["b", "c", "d", "e"]);
    expect(graph.descendants("e")).toEqual([]);
  });

  it("ignores duplicate edges", () => {
    const graph = DependencyGraph.from([edge("b", "a"), edge("b", "a")]);
    expect(graph.dependenciesOf("b")).toEqual(["a"]);
    expect(graph.edges()).toEqual([edge("b", "a")]);
  });

  it("returns new arrays: mutating them does not change the graph", () => {
    const graph = DependencyGraph.from(diamond);
    graph.ancestors("e").push("z");
    graph.dependenciesOf("d").push("z");
    graph.edges().pop();
    expect(graph.ancestors("e")).toEqual(["d", "b", "c", "a"]);
    expect(graph.dependenciesOf("d")).toEqual(["b", "c"]);
    expect(graph.edges()).toHaveLength(diamond.length);
  });

  describe("findCycle", () => {
    it("detects a task that depends on itself", () => {
      expect(DependencyGraph.from([]).findCycle(edge("a", "a"))).toEqual(["a", "a"]);
    });

    it("detects a direct cycle with its path", () => {
      const graph = DependencyGraph.from([edge("b", "a")]);
      expect(graph.findCycle(edge("a", "b"))).toEqual(["a", "b", "a"]);
    });

    it("detects a transitive cycle with the shortest path", () => {
      const graph = DependencyGraph.from(diamond);
      expect(graph.findCycle(edge("a", "e"))).toEqual(["a", "e", "d", "b", "a"]);
    });

    it("accepts edges that do not close a cycle, including a new diamond", () => {
      const graph = DependencyGraph.from(diamond);
      expect(graph.findCycle(edge("e", "a"))).toBeNull();
      expect(graph.findCycle(edge("e", "b"))).toBeNull();
      expect(graph.findCycle(edge("f", "e"))).toBeNull();
      expect(graph.findCycle(edge("c", "b"))).toBeNull();
    });

    it("is not confused by an edge that already exists", () => {
      expect(DependencyGraph.from(diamond).findCycle(edge("d", "b"))).toBeNull();
    });
  });
});

dependencyGraphReaderContract("in memory", (edges) => ({
  reader: new InMemoryDependencyGraphReader(edges),
  idOf: (name) => name,
}));
