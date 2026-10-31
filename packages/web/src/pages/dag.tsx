// Vista de DAG (docs/design.md §Front end): las dependencias reales entre tareas, de todos los
// proyectos o de uno. Las flechas van de lo que se debe terminar a lo que espera por ello.
import type { TaskGraphNode } from "@lunasq/schemas";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { Background, Controls, type Edge, ReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useMemo } from "react";
import { type TaskFlowNode, TaskNode } from "../components/dag/task-node.tsx";
import { Muted, Section } from "../components/section.tsx";
import { Loading, QueryError } from "../components/status.tsx";
import { TaskNumber } from "../components/task-number.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Label, Select } from "../components/ui/input.tsx";
import type { Json } from "../lib/api.ts";
import { layoutGraph, NODE_HEIGHT, NODE_WIDTH } from "../lib/dag-layout.ts";
import { queries } from "../lib/queries.ts";

const route = getRouteApi("/dag");

const nodeTypes = { task: TaskNode };

function Dependencies({
  nodes,
  edges,
}: {
  nodes: Json<TaskGraphNode>[];
  edges: { taskId: string; dependsOnId: string }[];
}) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return (
    <Section title="Dependencias">
      {edges.length === 0 ? (
        <Muted>Ninguna tarea depende de otra.</Muted>
      ) : (
        <ul aria-label="Dependencias" className="flex flex-col gap-1 text-sm">
          {edges.map((edge) => {
            const task = byId.get(edge.taskId);
            const dependsOn = byId.get(edge.dependsOnId);
            if (!task || !dependsOn) return null;
            return (
              <li
                key={`${edge.taskId}:${edge.dependsOnId}`}
                className="flex flex-wrap items-baseline gap-1"
              >
                <TaskNumber number={task.number} />
                <Link to="/tasks/$taskId" params={{ taskId: task.id }} className="hover:underline">
                  {task.intent}
                </Link>
                <span>depende de</span>
                <TaskNumber number={dependsOn.number} />
                <Link
                  to="/tasks/$taskId"
                  params={{ taskId: dependsOn.id }}
                  className="hover:underline"
                >
                  {dependsOn.intent}
                </Link>
                {task.projectId !== dependsOn.projectId && (
                  <Badge variant="destructive">otro proyecto</Badge>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

export function DagPage() {
  const { projectId } = route.useSearch();
  const navigate = route.useNavigate();
  const projects = useQuery(queries.projects());
  const graph = useQuery(queries.graph(projectId));

  const flow = useMemo(() => {
    if (!graph.data || !projects.data) return null;
    const names = new Map(projects.data.map((p) => [p.id, p.name]));
    const mixed = new Set(graph.data.nodes.map((n) => n.projectId)).size > 1;
    const laid = layoutGraph(graph.data);
    const nodes: TaskFlowNode[] = laid.nodes.map((n) => ({
      id: n.id,
      type: "task",
      position: n.position,
      // Con tamaño conocido el nodo se dibuja de inmediato, sin esperar a medirlo.
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      data: { task: n.task, projectName: mixed ? (names.get(n.task.projectId) ?? null) : null },
    }));
    const edges: Edge[] = laid.edges.map((e) => ({ ...e, type: "smoothstep" }));
    return { nodes, edges };
  }, [graph.data, projects.data]);

  const error = projects.error ?? graph.error;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h1 className="text-xl font-semibold">Dependencias entre tareas</h1>
        <div className="flex flex-col gap-1">
          <Label htmlFor="dag-project">Proyecto</Label>
          <Select
            id="dag-project"
            value={projectId ?? ""}
            onChange={(e) =>
              void navigate({ search: e.target.value ? { projectId: e.target.value } : {} })
            }
          >
            <option value="">Todos los proyectos</option>
            {projects.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </div>
      </div>
      {error ? (
        <QueryError error={error} />
      ) : !graph.data || !flow ? (
        <Loading />
      ) : graph.data.nodes.length === 0 ? (
        <Muted>Sin tareas que mostrar.</Muted>
      ) : (
        <>
          <section
            aria-label="Grafo de dependencias"
            className="h-[560px] rounded-lg border border-border"
          >
            <ReactFlow
              nodes={flow.nodes}
              edges={flow.edges}
              nodeTypes={nodeTypes}
              nodesDraggable={false}
              nodesConnectable={false}
              fitView
              minZoom={0.2}
            >
              <Background />
              <Controls showInteractive={false} />
            </ReactFlow>
          </section>
          <Dependencies nodes={graph.data.nodes} edges={graph.data.edges} />
        </>
      )}
    </div>
  );
}
