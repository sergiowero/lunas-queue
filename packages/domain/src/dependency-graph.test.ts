import { describe, expect, it } from "vitest";
import {
  type DependencyEdge,
  DependencyGraph,
  InMemoryDependencyGraphReader,
} from "./dependency-graph.ts";
import { dependencyGraphReaderContract } from "./testing.ts";

const edge = (taskId: string, dependsOnId: string): DependencyEdge => ({ taskId, dependsOnId });

// d depende de b y c; b y c dependen de a; e depende de d.  a ← b,c ← d ← e
const diamond = [edge("b", "a"), edge("c", "a"), edge("d", "b"), edge("d", "c"), edge("e", "d")];

describe("DependencyGraph", () => {
  it("expone dependencias y dependientes directos", () => {
    const graph = DependencyGraph.from(diamond);
    expect(graph.dependenciesOf("d")).toEqual(["b", "c"]);
    expect(graph.dependentsOf("a")).toEqual(["b", "c"]);
    expect(graph.dependenciesOf("a")).toEqual([]);
    expect(graph.dependentsOf("desconocida")).toEqual([]);
  });

  it("ancestros: todas las tareas de las que depende, por distancia y sin repetir", () => {
    const graph = DependencyGraph.from(diamond);
    expect(graph.ancestors("e")).toEqual(["d", "b", "c", "a"]);
    expect(graph.ancestors("a")).toEqual([]);
  });

  it("descendientes: todas las tareas que bloquea, por distancia y sin repetir", () => {
    const graph = DependencyGraph.from(diamond);
    expect(graph.descendants("a")).toEqual(["b", "c", "d", "e"]);
    expect(graph.descendants("e")).toEqual([]);
  });

  it("ignora aristas duplicadas", () => {
    const graph = DependencyGraph.from([edge("b", "a"), edge("b", "a")]);
    expect(graph.dependenciesOf("b")).toEqual(["a"]);
    expect(graph.edges()).toEqual([edge("b", "a")]);
  });

  it("devolver arreglos nuevos: mutarlos no cambia el grafo", () => {
    const graph = DependencyGraph.from(diamond);
    graph.ancestors("e").push("z");
    graph.dependenciesOf("d").push("z");
    graph.edges().pop();
    expect(graph.ancestors("e")).toEqual(["d", "b", "c", "a"]);
    expect(graph.dependenciesOf("d")).toEqual(["b", "c"]);
    expect(graph.edges()).toHaveLength(diamond.length);
  });

  describe("findCycle", () => {
    it("detecta una tarea que depende de sí misma", () => {
      expect(DependencyGraph.from([]).findCycle(edge("a", "a"))).toEqual(["a", "a"]);
    });

    it("detecta un ciclo directo con su camino", () => {
      const graph = DependencyGraph.from([edge("b", "a")]);
      expect(graph.findCycle(edge("a", "b"))).toEqual(["a", "b", "a"]);
    });

    it("detecta un ciclo transitivo con el camino más corto", () => {
      const graph = DependencyGraph.from(diamond);
      expect(graph.findCycle(edge("a", "e"))).toEqual(["a", "e", "d", "b", "a"]);
    });

    it("acepta aristas que no cierran ciclo, incluido un nuevo diamante", () => {
      const graph = DependencyGraph.from(diamond);
      expect(graph.findCycle(edge("e", "a"))).toBeNull();
      expect(graph.findCycle(edge("e", "b"))).toBeNull();
      expect(graph.findCycle(edge("f", "e"))).toBeNull();
      expect(graph.findCycle(edge("c", "b"))).toBeNull();
    });

    it("no se confunde con una arista que ya existe", () => {
      expect(DependencyGraph.from(diamond).findCycle(edge("d", "b"))).toBeNull();
    });
  });
});

dependencyGraphReaderContract("en memoria", (edges) => ({
  reader: new InMemoryDependencyGraphReader(edges),
  idOf: (name) => name,
}));
