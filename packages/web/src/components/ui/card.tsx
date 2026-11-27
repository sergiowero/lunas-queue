import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.ts";

export function Card({ className, ...props }: ComponentProps<"section">) {
  return <section className={cn("card", className)} {...props} />;
}

export function CardHeader({ className, ...props }: ComponentProps<"header">) {
  return <header className={cn("flex flex-col gap-1 px-5 pt-4 pb-2", className)} {...props} />;
}

export function CardTitle({ className, ...props }: ComponentProps<"h2">) {
  return (
    <h2
      className={cn("text-[15px] font-semibold leading-tight tracking-tight", className)}
      {...props}
    />
  );
}

export function CardContent({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("px-5 pt-2 pb-5", className)} {...props} />;
}
