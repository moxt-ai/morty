import { Link, useRouterState } from "@tanstack/react-router";
import { useState } from "react";
import { Input } from "../ui/input.tsx";
import { PLAYGROUND_ENTRIES, type PlaygroundEntry, playgroundGroups } from "./catalog.ts";

function matchesQuery(entry: PlaygroundEntry, query: string): boolean {
    if (query.length === 0) {
        return true;
    }
    const haystack = `${entry.title} ${entry.group} ${entry.source}`.toLocaleLowerCase();
    return haystack.includes(query);
}

export function LibrarySidebar() {
    const [query, setQuery] = useState("");
    const pathname = useRouterState({ select: (state) => state.location.pathname });
    const normalized = query.trim().toLocaleLowerCase();
    const visible = PLAYGROUND_ENTRIES.filter((entry) => matchesQuery(entry, normalized));
    const groups = playgroundGroups(visible);
    return (
        <aside className="flex max-h-72 shrink-0 flex-col border-b border-border bg-sidebar md:max-h-none md:w-[248px] md:border-r md:border-b-0">
            <div className="px-4 pt-5 pb-3">
                <Link
                    className="flex items-center gap-2.5 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
                    to="/playground"
                >
                    <span
                        aria-hidden="true"
                        className="flex size-8 items-center justify-center rounded-lg bg-primary text-lg text-primary-foreground"
                    >
                        ∞
                    </span>
                    <span>
                        <span className="block text-14 font-semibold tracking-tight">Morty</span>
                        <span className="block text-12 text-muted-foreground">Component library</span>
                    </span>
                </Link>
                <div className="mt-4">
                    <label className="sr-only" htmlFor="playground-search">
                        Find a component
                    </label>
                    <Input
                        id="playground-search"
                        onChange={(event) => setQuery(event.currentTarget.value)}
                        placeholder="Find a component"
                        value={query}
                    />
                </div>
            </div>
            <nav aria-label="Components" className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
                {groups.length === 0 ? (
                    <p className="px-2 py-3 text-13 text-muted-foreground">No components match.</p>
                ) : (
                    groups.map((group) => (
                        <div className="mt-3 first:mt-0" key={group}>
                            <p className="px-2 py-1 text-11 font-semibold tracking-[0.04em] text-muted-foreground uppercase">
                                {group}
                            </p>
                            <ul className="grid gap-0.5">
                                {visible
                                    .filter((entry) => entry.group === group)
                                    .map((entry) => {
                                        const active = pathname === `/playground/${entry.id}`;
                                        return (
                                            <li key={entry.id}>
                                                <Link
                                                    aria-current={active ? "page" : undefined}
                                                    className={`block rounded-lg px-2 py-1.5 text-13 outline-none focus-visible:ring-2 focus-visible:ring-ring/70 ${
                                                        active
                                                            ? "bg-accent-active font-medium text-foreground"
                                                            : "text-muted-foreground hover:bg-accent hover:text-foreground"
                                                    }`}
                                                    params={{ entryId: entry.id }}
                                                    to="/playground/$entryId"
                                                >
                                                    {entry.title}
                                                </Link>
                                            </li>
                                        );
                                    })}
                            </ul>
                        </div>
                    ))
                )}
            </nav>
        </aside>
    );
}
