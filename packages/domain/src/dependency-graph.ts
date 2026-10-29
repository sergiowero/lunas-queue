// Reglas del DAG de dependencias (docs/design.md §Scheduler, ADR 0010). TypeScript puro: quien
// llama carga las aristas; aquí se detectan ciclos y se calculan ancestros y descendientes.

/** `taskId` depende de `dependsOnId`: no está lista hasta que la dependencia se entregue. */
export type DependencyEdge = { taskId: string; dependsOnId: string };

/** Grafo inmutable; todos los métodos devuelven arreglos nuevos. */
export class DependencyGraph {
  // taskId → sus dependencias, y dependsOnId → sus dependientes, en orden de inserción.
  readonly #dependencies = new Map<string, Set<string>>();
  readonly #dependents = new Map<string, Set<string>>();

  private constructor(edges: readonly DependencyEdge[]) {
    for (const { taskId, dependsOnId } of edges) {
      link(this.#dependencies, taskId, dependsOnId);
      link(this.#dependents, dependsOnId, taskId);
    }
  }

  static from(edges: readonly DependencyEdge[]): DependencyGraph {
    return new DependencyGraph(edges);
  }

  edges(): DependencyEdge[] {
    return [...this.#dependencies].flatMap(([taskId, deps]) =>
      [...deps].map((dependsOnId) => ({ taskId, dependsOnId })),
    );
  }

  dependenciesOf(taskId: string): string[] {
    return [...(this.#dependencies.get(taskId) ?? [])];
  }

  dependentsOf(taskId: string): string[] {
    return [...(this.#dependents.get(taskId) ?? [])];
  }

  /** Todas las tareas de las que depende, directa o transitivamente, de la más cercana a la más lejana. */
  ancestors(taskId: string): string[] {
    return [...walk(this.#dependencies, taskId).keys()];
  }

  /** Todas las tareas que bloquea, directa o transitivamente: el boost del scheduler. */
  descendants(taskId: string): string[] {
    return [...walk(this.#dependents, taskId).keys()];
  }

  /**
   * Si agregar `edge` cerraría un ciclo, devuelve el camino más corto que lo cierra, empezando y
   * terminando en `edge.taskId` (`[a, a]` para una tarea que depende de sí misma); si no, null.
   */
  findCycle({ taskId, dependsOnId }: DependencyEdge): string[] | null {
    if (taskId === dependsOnId) return [taskId, taskId];
    // Hay ciclo si dependsOnId ya depende, directa o transitivamente, de taskId.
    const parents = walk(this.#dependencies, dependsOnId);
    if (!parents.has(taskId)) return null;
    const path = [taskId];
    for (let node: string | undefined = parents.get(taskId); node; node = parents.get(node)) {
      path.push(node);
    }
    return [taskId, dependsOnId, ...path.reverse()];
  }
}

function link(map: Map<string, Set<string>>, from: string, to: string): void {
  let targets = map.get(from);
  if (!targets) {
    targets = new Set();
    map.set(from, targets);
  }
  targets.add(to);
}

/**
 * BFS desde `start` sin incluirlo. Devuelve cada nodo alcanzado, en orden de visita, con el nodo
 * desde el que se llegó (undefined para los vecinos de `start`).
 */
function walk(adjacency: Map<string, Set<string>>, start: string): Map<string, string | undefined> {
  const parents = new Map<string, string | undefined>();
  const queue = [start];
  for (let i = 0; i < queue.length; i++) {
    const node = queue[i] as string;
    for (const next of adjacency.get(node) ?? []) {
      if (next === start || parents.has(next)) continue;
      parents.set(next, node === start ? undefined : node);
      queue.push(next);
    }
  }
  return parents;
}

/** Puerto de lectura del DAG: el scheduler toma un snapshot por tick y calcula sobre él. */
export interface DependencyGraphReader {
  snapshot(): DependencyGraph;
}

/** Reader en memoria para tests de los módulos que consumen el DAG. */
export class InMemoryDependencyGraphReader implements DependencyGraphReader {
  readonly #edges: DependencyEdge[];

  constructor(edges: readonly DependencyEdge[] = []) {
    this.#edges = edges.map((edge) => ({ ...edge }));
  }

  snapshot(): DependencyGraph {
    return DependencyGraph.from(this.#edges);
  }
}
