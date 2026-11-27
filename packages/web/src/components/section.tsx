import { type ReactNode, useId } from "react";
import { Badge } from "./ui/badge.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card.tsx";

/** Block with a title that screen readers (and tests) see as a named region. */
export function Section({
  title,
  count,
  children,
}: {
  title: string;
  /** Optional number of items, shown as a small badge next to the title (outside its name). */
  count?: number | undefined;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <Card aria-labelledby={id}>
      <CardHeader className="flex-row items-center gap-2">
        <CardTitle id={id}>{title}</CardTitle>
        {count !== undefined && count > 0 && (
          <Badge variant="secondary" aria-hidden="true" className="tabular-nums">
            {count}
          </Badge>
        )}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export function Muted({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}
