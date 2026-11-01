import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.ts";

export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-all duration-150 ease-out-expo active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "bg-primary bg-linear-to-b from-white/12 to-transparent text-primary-fg shadow-sm hover:bg-primary-hover",
        destructive:
          "bg-danger bg-linear-to-b from-white/12 to-transparent text-danger-fg shadow-sm hover:bg-danger-hover",
        outline:
          "border border-border bg-surface text-text shadow-xs hover:border-border-strong hover:bg-surface-secondary",
        secondary: "bg-surface-secondary text-text hover:bg-surface-tertiary",
        ghost: "text-text hover:bg-surface-secondary",
      },
      size: { default: "h-9 px-4 py-2", sm: "h-8 px-3", lg: "h-10 px-6" },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export function Button({
  className,
  variant,
  size,
  type = "button",
  ...props
}: ComponentProps<"button"> & VariantProps<typeof buttonVariants>) {
  return (
    <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  );
}
