// Layout del DAG de dependencias (UW-25): dagre de izquierda a derecha, con las dependencias a la
// izquierda de quienes dependen de ellas. React Flow solo dibuja lo que esto le da.
import { graphlib, layout } from "@dagrejs/dagre";
import type { TaskGraph, TaskGraphNode } from "@lunasq/schemas";
import type { Json } from "./api.ts";

export const NODE_WIDTH = 260;
export const NODE_HEIGHT = 96;

export type LaidOutNode = {
  id: string;
  task: Json<TaskGraphNode>;
  position: { x: number; y: number };
};
export type LaidOutEdge = { id: string; source: string; target: string };
export type LaidOutGraph = { nodes: LaidOutNode[]; edges: LaidOutEdge[] };

export function layoutGraph(graph: Json<TaskGraph>): LaidOutGraph {
  const g = new graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 32, ranksep: 96 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const task of graph.nodes) g.setNode(task.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  const ids = new Set(graph.nodes.map((n) => n.id));
  const edges = graph.edges.filter((e) => ids.has(e.taskId) && ids.has(e.dependsOnId));
  for (const e of edges) g.setEdge(e.dependsOnId, e.taskId);
  layout(g);
  return {
    nodes: graph.nodes.map((task) => {
      const placed = g.node(task.id);
      // dagre devuelve el centro; React Flow ubica por la esquina superior izquierda.
      return {
        id: task.id,
        task,
        position: { x: placed.x - NODE_WIDTH / 2, y: placed.y - NODE_HEIGHT / 2 },
      };
    }),
    edges: edges.map((e) => ({
      id: `${e.dependsOnId}->${e.taskId}`,
      source: e.dependsOnId,
      target: e.taskId,
    })),
  };
}
