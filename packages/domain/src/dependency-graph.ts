// Rules of the dependency DAG (docs/design.md §Scheduler, ADR 0010). Pure TypeScript: the
// caller loads the edges; here cycles are detected and ancestors and descendants are computed.

/** `taskId` depends on `dependsOnId`: it is not ready until the dependency is delivered. */
export type DependencyEdge = { taskId: string; dependsOnId: string };

/** Immutable graph; every method returns new arrays. */
export class DependencyGraph {
  // taskId → its dependencies, and dependsOnId → its dependents, in insertion order.
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

  /** Every task it depends on, directly or transitively, from the nearest to the farthest. */
  ancestors(taskId: string): string[] {
    return [...walk(this.#dependencies, taskId).keys()];
  }

  /** Every task it blocks, directly or transitively: the scheduler boost. */
  descendants(taskId: string): string[] {
    return [...walk(this.#dependents, taskId).keys()];
  }

  /**
   * If adding `edge` would close a cycle, returns the shortest path that closes it, starting and
   * ending at `edge.taskId` (`[a, a]` for a task that depends on itself); otherwise null.
   */
  findCycle({ taskId, dependsOnId }: DependencyEdge): string[] | null {
    if (taskId === dependsOnId) return [taskId, taskId];
    // There is a cycle if dependsOnId already depends, directly or transitively, on taskId.
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
 * BFS from `start` without including it. Returns every node reached, in visit order, with the node
 * it was reached from (undefined for the neighbours of `start`).
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

/** Read port of the DAG: the scheduler takes a snapshot per tick and computes on it. */
export interface DependencyGraphReader {
  snapshot(): DependencyGraph;
}

/** In-memory reader for tests of the modules that consume the DAG. */
export class InMemoryDependencyGraphReader implements DependencyGraphReader {
  readonly #edges: DependencyEdge[];

  constructor(edges: readonly DependencyEdge[] = []) {
    this.#edges = edges.map((edge) => ({ ...edge }));
  }

  snapshot(): DependencyGraph {
    return DependencyGraph.from(this.#edges);
  }
}
