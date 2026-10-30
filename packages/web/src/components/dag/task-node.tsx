import type { TaskGraphNode } from "@lunasq/schemas";
import { Link } from "@tanstack/react-router";
import { Handle, type Node, type NodeProps, Position } from "@xyflow/react";
import type { Json } from "../../lib/api.ts";
import { NODE_HEIGHT, NODE_WIDTH } from "../../lib/dag-layout.ts";
import { StateBadges } from "../status.tsx";
import { Badge } from "../ui/badge.tsx";

export type TaskNodeData = {
  task: Json<TaskGraphNode>;
  /** Solo cuando el grafo mezcla proyectos. */
  projectName: string | null;
};
export type TaskFlowNode = Node<TaskNodeData, "task">;

export function TaskNode({ data: { task, projectName } }: NodeProps<TaskFlowNode>) {
  return (
    <div
      style={{ width: NODE_WIDTH, height: NODE_HEIGHT }}
      className="flex flex-col justify-between rounded-md border border-border bg-background p-2 text-sm shadow-sm"
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <Link
        to="/tasks/$taskId"
        params={{ taskId: task.id }}
        title={task.intent}
        className="line-clamp-2 font-medium hover:underline"
      >
        {task.intent}
      </Link>
      <div className="flex flex-wrap items-center gap-1">
        <StateBadges state={task.state} subState={task.subState} />
        {task.prState && <Badge variant="outline">PR {task.prState}</Badge>}
        {projectName && <Badge variant="outline">{projectName}</Badge>}
      </div>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}
