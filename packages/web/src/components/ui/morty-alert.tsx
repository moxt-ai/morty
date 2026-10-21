import { CircleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function MortyAlert({ children, className }: { readonly children: ReactNode; readonly className?: string }) {
    return (
        <div
            className={cn(
                "flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2.5 text-sm leading-5 text-destructive [overflow-wrap:anywhere]",
                className,
            )}
            role="alert"
        >
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <p className="min-w-0 flex-1">{children}</p>
        </div>
    );
}
