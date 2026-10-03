import type * as React from "react";
import { cn } from "@/lib/utils";

/** The look every field shares: a well, a step below what holds it; violet when I'm in it. */
export const field =
  "rounded-md border border-input/70 bg-field shadow-[inset_0_1px_2px_rgb(0_0_0/0.06)] transition-[color,border-color,box-shadow] duration-150 outline-none hover:border-input focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary/20 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 disabled:cursor-not-allowed disabled:opacity-50";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        field,
        "h-9 w-full min-w-0 pointer-coarse:min-h-11 px-3 py-1 text-base selection:bg-primary/30 file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none md:text-sm",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
