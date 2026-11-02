import { type ReactNode, useId } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card.tsx";

/** Block with a title that screen readers (and tests) see as a named region. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <Card aria-labelledby={id}>
      <CardHeader>
        <CardTitle id={id}>{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export function Muted({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}
