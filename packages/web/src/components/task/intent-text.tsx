// Intent with its #N mentions linked to the mentioned task's detail (ADR 0015). Only for
// where the intent is not already inside a link: cards and rows show it as plain text.
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { splitMentions } from "../../lib/mentions.ts";
import { queries } from "../../lib/queries.ts";

export function IntentText({ intent }: { intent: string }) {
  const parts = useMemo(() => splitMentions(intent), [intent]);
  const hasMentions = parts.some((part) => typeof part !== "string");
  // Without mentions there is no need to resolve numbers: the tasks are not requested.
  const tasks = useQuery({ ...queries.tasks(), enabled: hasMentions });
  const byNumber = useMemo(
    () => new Map((tasks.data ?? []).map((task) => [task.number, task.id])),
    [tasks.data],
  );
  return parts.map((part, i) => {
    if (typeof part === "string") return part;
    const taskId = byNumber.get(part.number);
    if (!taskId) return part.text;
    return (
      // biome-ignore lint/suspicious/noArrayIndexKey: the chunks do not change order.
      <Link key={i} to="/tasks/$taskId" params={{ taskId }} className="underline">
        {part.text}
      </Link>
    );
  });
}
