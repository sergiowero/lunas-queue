import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.ts";

export const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ring-1 ring-inset",
  {
    variants: {
      variant: {
        default: "bg-primary/10 text-primary-text ring-primary/20",
        secondary: "bg-surface-secondary text-text-secondary ring-border",
        destructive: "bg-danger/10 text-danger-text ring-danger/20",
        info: "bg-info/10 text-info-text ring-info/20",
        outline: "bg-transparent text-text-secondary ring-border-strong",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export function Badge({
  className,
  variant,
  ...props
}: ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return (
    <span
      data-variant={variant ?? "default"}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}
