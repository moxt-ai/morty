import type { ReactNode } from "react";

export function Specimen({
    children,
    layout = "row",
    title,
}: {
    readonly children: ReactNode;
    readonly layout?: "row" | "stack";
    readonly title: string;
}) {
    return (
        <section className="overflow-hidden rounded-xl border border-border bg-card">
            <h3 className="border-b border-border bg-sidebar px-4 py-2 text-12 font-medium text-muted-foreground">
                {title}
            </h3>
            <div className={layout === "stack" ? "grid gap-4 p-4" : "flex flex-wrap items-center gap-3 p-4"}>
                {children}
            </div>
        </section>
    );
}
