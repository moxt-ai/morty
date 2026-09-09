import { Link } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { Button } from "../../components/ui/button.tsx";
import { Card } from "../../components/ui/card.tsx";
import { Dialog } from "../../components/ui/dialog.tsx";
import { Input } from "../../components/ui/input.tsx";
import { workspacePageSize } from "../../view-models/workspaces/contracts.ts";
import type { loadWorkspace, loadWorkspaces, MutationResult } from "../../view-models/workspaces/data.ts";
import { workspaceErrorMessage } from "../../view-models/workspaces/data.ts";
import type { WorkspaceStore } from "../../view-models/workspaces/store.ts";

type MutateWorkspace = (form: FormData, signal: AbortSignal) => Promise<MutationResult>;

function WorkspaceDialog({ ui, mutate }: { readonly ui: WorkspaceStore; readonly mutate: MutateWorkspace }) {
    const dialog = useStore(ui, (state) => state.dialog);
    const close = useStore(ui, (state) => state.closeDialog);
    const setName = useStore(ui, (state) => state.setName);
    const controller = useRef<AbortController>(undefined);
    const [submission, setSubmission] = useState<
        { readonly kind: "idle" } | { readonly kind: "busy" } | MutationResult
    >({ kind: "idle" });
    useEffect(() => () => controller.current?.abort(new DOMException("Unmounted", "AbortError")), []);
    if (dialog.kind === "closed") {
        return null;
    }
    const busy = submission.kind === "busy";

    const submit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (busy) {
            return;
        }
        const request = new AbortController();
        controller.current = request;
        setSubmission({ kind: "busy" });
        void mutate(new FormData(event.currentTarget), request.signal).then(
            (result) => {
                if (!request.signal.aborted) {
                    setSubmission(result);
                }
            },
            (cause: unknown) => {
                if (!request.signal.aborted) {
                    setSubmission({
                        kind: "failure",
                        message: workspaceErrorMessage(cause),
                    });
                }
            },
        );
    };

    return (
        <Dialog
            title={dialog.kind === "create" ? "New workspace" : "Delete workspace?"}
            description={
                dialog.kind === "create"
                    ? "Create a shared place for your team and agents."
                    : "Deleting a workspace removes access for all its members."
            }
            busy={busy}
            onClose={close}
        >
            <form onSubmit={submit}>
                <input type="hidden" name="intent" value={dialog.kind} />
                {dialog.kind === "create" ? (
                    <div className="mt-6">
                        <label htmlFor="workspace-name" className="mb-2 block text-sm font-medium">
                            Workspace name
                        </label>
                        <Input
                            id="workspace-name"
                            name="name"
                            value={dialog.name}
                            onChange={(event) => setName(event.target.value)}
                            maxLength={100}
                            required
                            disabled={busy}
                            placeholder="e.g. Research team"
                        />
                    </div>
                ) : (
                    <>
                        <input type="hidden" name="id" value={dialog.workspace.id} />
                        <p className="mt-4 text-[13px] leading-6 text-muted-foreground">
                            Delete <strong className="break-words text-foreground">{dialog.workspace.name}</strong> and
                            remove access for all its members? This cannot be undone.
                        </p>
                    </>
                )}
                {submission.kind === "failure" && (
                    <p role="alert" className="mt-4 text-sm text-red-700">
                        {submission.message}
                    </p>
                )}
                <div className="mt-7 flex justify-end gap-3">
                    <Button disabled={busy} onClick={close} variant="outline">
                        Cancel
                    </Button>
                    <Button
                        type="submit"
                        disabled={busy || (dialog.kind === "create" && !dialog.name.trim())}
                        variant={dialog.kind === "create" ? "primary" : "destructive"}
                    >
                        {busy ? "Saving…" : dialog.kind === "create" ? "Create workspace" : "Delete workspace"}
                    </Button>
                </div>
            </form>
        </Dialog>
    );
}

export function WorkspaceList({
    data,
    mutate,
    refresh,
    ui,
}: {
    readonly data: Awaited<ReturnType<typeof loadWorkspaces>>;
    readonly mutate: MutateWorkspace;
    readonly refresh: () => Promise<void>;
    readonly ui: WorkspaceStore;
}) {
    const { items, page, totalCount } = data;
    const newWorkspace = useStore(ui, (state) => state.newWorkspace);
    const confirmDelete = useStore(ui, (state) => state.confirmDelete);
    const dialog = useStore(ui, (state) => state.dialog);
    const [refreshing, setRefreshing] = useState(false);
    const runRefresh = () => {
        setRefreshing(true);
        void refresh().finally(() => setRefreshing(false));
    };

    return (
        <>
            <div className="mb-9 flex flex-wrap items-end justify-between gap-5">
                <div>
                    <p className="mb-2 text-xs font-medium text-primary">Mobius Cloud</p>
                    <h1 className="text-2xl font-semibold tracking-tight">Workspaces</h1>
                    <p className="mt-2 text-[13px] text-muted-foreground">A shared place for your team and agents.</p>
                </div>
                <Button onClick={newWorkspace}>New workspace</Button>
            </div>
            {items.length === 0 ? (
                <Card asChild className="border-dashed px-6 py-16 text-center">
                    <section>
                        <h2 className="text-lg font-semibold">No workspaces yet</h2>
                        <p className="mt-2 text-[13px] text-muted-foreground">Create a workspace to get started.</p>
                    </section>
                </Card>
            ) : (
                <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {items.map((workspace) => (
                        <Card asChild key={workspace.id} className="flex flex-col">
                            <li>
                                <Link
                                    to="/workspaces/$workspaceId"
                                    params={{ workspaceId: workspace.id }}
                                    className="flex flex-1 items-center gap-3 rounded-t-xl p-5 text-[13px] transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                                >
                                    <span
                                        aria-hidden="true"
                                        className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-sm font-semibold text-primary"
                                    >
                                        {workspace.name.slice(0, 1).toUpperCase()}
                                    </span>
                                    <span className="break-words font-semibold">{workspace.name}</span>
                                </Link>
                                <div className="flex min-h-12 items-center justify-between border-t border-border px-5 py-2 text-xs">
                                    <span className="text-muted-foreground">Workspace</span>
                                    {workspace.canDelete && (
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            aria-label={`Delete ${workspace.name}`}
                                            onClick={() => confirmDelete(workspace)}
                                            className="hover:text-destructive"
                                        >
                                            Delete
                                        </Button>
                                    )}
                                </div>
                            </li>
                        </Card>
                    ))}
                </ul>
            )}
            <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
                <Button variant="ghost" size="sm" disabled={refreshing} onClick={runRefresh}>
                    Refresh workspaces
                </Button>
                {totalCount > workspacePageSize && (
                    <nav aria-label="Workspace pages" className="flex items-center gap-4">
                        {page > 1 ? (
                            <Button asChild variant="outline">
                                <Link to="/" search={{ page: page - 1 }}>
                                    Previous
                                </Link>
                            </Button>
                        ) : (
                            <Button variant="outline" disabled>
                                Previous
                            </Button>
                        )}
                        <span className="text-xs text-muted-foreground">Page {page}</span>
                        {page * workspacePageSize < totalCount ? (
                            <Button asChild variant="outline">
                                <Link to="/" search={{ page: page + 1 }}>
                                    Next
                                </Link>
                            </Button>
                        ) : (
                            <Button variant="outline" disabled>
                                Next
                            </Button>
                        )}
                    </nav>
                )}
            </div>
            {dialog.kind !== "closed" && <WorkspaceDialog ui={ui} mutate={mutate} />}
        </>
    );
}

export function WorkspaceDetail({
    workspace,
    children,
}: {
    readonly workspace: Awaited<ReturnType<typeof loadWorkspace>>;
    readonly children: ReactNode;
}) {
    return (
        <>
            <Button asChild variant="ghost" size="sm">
                <Link to="/" search={{ page: 1 }}>
                    ← All workspaces
                </Link>
            </Button>
            <section className="mt-8">
                <p className="mb-3 break-words text-sm font-medium text-primary">{workspace.name}</p>
                <div className="mt-6">{children}</div>
            </section>
        </>
    );
}

export function WorkspaceFailure({
    cause,
    message,
    refresh,
}: {
    readonly cause?: unknown;
    readonly message?: string;
    readonly refresh?: () => void;
}) {
    return (
        <>
            <Button asChild variant="ghost" size="sm">
                <Link to="/" search={{ page: 1 }}>
                    ← All workspaces
                </Link>
            </Button>
            <p role="alert" className="mt-8 rounded-xl border border-red-200 bg-white p-6 text-red-700">
                {message ?? workspaceErrorMessage(cause)}
            </p>
            {refresh && (
                <Button variant="ghost" onClick={refresh} className="mt-5">
                    Refresh workspaces
                </Button>
            )}
        </>
    );
}
