import React from "react";
import { cn } from "@/lib/utils";

export function Dashboard({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex-1 overflow-y-auto bg-zinc-950 relative p-4 sm:p-6 lg:p-8", className)}>
      {children}
    </div>
  );
}
