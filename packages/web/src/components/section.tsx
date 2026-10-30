import { type ReactNode, useId } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card.tsx";

/** Bloque con título que los lectores de pantalla (y los tests) ven como región con nombre. */
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
