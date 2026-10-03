import type * as React from "react";
import { field } from "@/components/ui/input";
import { cn } from "@/lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        field,
        "flex field-sizing-content min-h-16 w-full px-3 py-2 text-base placeholder:text-muted-foreground md:text-sm",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
