import { Link, Outlet, useParams } from "@tanstack/react-router";
import { PLAYGROUND_ENTRIES, playgroundEntry, playgroundGroups } from "../../components/playground/catalog.ts";
import { PlaygroundGallery } from "../../components/playground/galleries.tsx";
import { LibrarySidebar } from "../../components/playground/library-sidebar.tsx";
import { SourcePath } from "../../components/playground/source-path.tsx";
import { textLinkClassName } from "../../components/ui/text-link.ts";

export function PlaygroundShell() {
    return (
        <div className="flex h-dvh min-h-0 flex-col bg-background text-foreground md:flex-row">
            <LibrarySidebar />
            <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
                <div className="mx-auto w-full max-w-[960px] px-5 py-8 sm:px-8">
                    <Outlet />
                </div>
            </div>
        </div>
    );
}

export function PlaygroundHome() {
    const groups = playgroundGroups(PLAYGROUND_ENTRIES);
    return (
        <div>
            <header className="mb-8">
                <h1 className="text-28 font-semibold tracking-[-0.03em]">Component library</h1>
                <p className="mt-2 max-w-2xl text-14 leading-6 text-muted-foreground">
                    Real Morty components, with their variants and the file to edit. This page does not require a
                    signed-in session.
                </p>
            </header>
            <div className="grid gap-8">
                {groups.map((group) => (
                    <section aria-labelledby={`playground-group-${group}`} key={group}>
                        <h2
                            className="text-12 font-semibold tracking-[0.04em] text-muted-foreground uppercase"
                            id={`playground-group-${group}`}
                        >
                            {group}
                        </h2>
                        <ul className="mt-3 grid gap-3 sm:grid-cols-2">
                            {PLAYGROUND_ENTRIES.filter((entry) => entry.group === group).map((entry) => (
                                <li key={entry.id}>
                                    <Link
                                        className="block h-full rounded-xl border border-border bg-card px-4 py-4 outline-none transition-colors hover:bg-accent keyboard-focus:focus-visible:ring-[3px] keyboard-focus:focus-visible:ring-ring/70"
                                        params={{ entryId: entry.id }}
                                        to="/playground/$entryId"
                                    >
                                        <span className="block text-14 font-semibold">{entry.title}</span>
                                        <span className="mt-1 block text-13 leading-5 text-muted-foreground">
                                            {entry.summary}
                                        </span>
                                        <span className="mt-3 block font-mono text-11 text-morty-text-3">
                                            {entry.source}
                                        </span>
                                    </Link>
                                </li>
                            ))}
                        </ul>
                    </section>
                ))}
            </div>
        </div>
    );
}

export function PlaygroundEntryPage() {
    const { entryId } = useParams({ from: "/playground/$entryId" });
    const entry = playgroundEntry(entryId);
    if (entry === undefined) {
        return (
            <div>
                <p className="text-14 text-destructive" role="alert">
                    Unknown component: {entryId}
                </p>
                <Link className={`mt-4 inline-block text-14 font-medium ${textLinkClassName}`} to="/playground">
                    Back to the library
                </Link>
            </div>
        );
    }
    return (
        <div>
            <header className="mb-8">
                <p className="text-12 font-medium text-primary">{entry.group}</p>
                <h1 className="mt-1 text-28 font-semibold tracking-[-0.03em]">{entry.title}</h1>
                <p className="mt-2 max-w-2xl text-14 leading-6 text-muted-foreground">{entry.summary}</p>
                <SourcePath source={entry.source} />
            </header>
            <PlaygroundGallery id={entry.id} />
        </div>
    );
}
