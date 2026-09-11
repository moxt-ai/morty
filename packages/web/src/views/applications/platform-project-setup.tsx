import { useEffect, useId, useRef, useState } from "react";
import { Card } from "../../components/ui/card.tsx";
import { Button } from "../../components/ui/cloud-button.tsx";
import { Input } from "../../components/ui/input.tsx";
import type { ManagedProject, ManagementApi } from "../../services/management/management-api.ts";

type ProjectState =
    | { readonly kind: "loading" }
    | { readonly kind: "unconfigured" }
    | { readonly kind: "creating" }
    | { readonly kind: "ready"; readonly project: ManagedProject }
    | { readonly kind: "failed"; readonly message: string };

export function PlatformProjectSetup({
    requests,
}: {
    readonly requests: Pick<ManagementApi, "readProject" | "createProject">;
}) {
    const [state, setState] = useState<ProjectState>({ kind: "loading" });
    const [displayName, setDisplayName] = useState("My Project");
    const nameId = useId();
    const lifetime = useRef<AbortController | null>(null);
    useEffect(() => {
        const controller = new AbortController();
        lifetime.current = controller;
        setState({ kind: "loading" });
        void requests
            .readProject(controller.signal)
            .then((project) => {
                if (!controller.signal.aborted) {
                    setState(project === null ? { kind: "unconfigured" } : { kind: "ready", project });
                }
            })
            .catch(() => {
                if (!controller.signal.aborted) {
                    setState({ kind: "failed", message: "Could not load your Platform Project. Try again." });
                }
            });
        return () => {
            controller.abort();
            lifetime.current = null;
        };
    }, [requests]);

    return (
        <Card className="mb-5 grid gap-4 p-5 sm:p-6">
            <header>
                <h2 className="text-xl font-semibold">Platform Project</h2>
                <p className="mt-1 text-[13px] text-muted-foreground">
                    Create your agent workspace. You can bind an account later.
                </p>
            </header>
            {state.kind === "loading" ? (
                <p role="status">Loading Project…</p>
            ) : state.kind === "ready" ? (
                <div role="status">
                    <p>{state.project.displayName}</p>
                    <p className="text-sm text-muted-foreground">Project connected</p>
                </div>
            ) : (
                <form
                    className="flex flex-wrap items-end gap-3"
                    onSubmit={(event) => {
                        event.preventDefault();
                        if (state.kind === "creating" || lifetime.current === null) {
                            return;
                        }
                        const controller = lifetime.current;
                        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]);
                        setState({ kind: "creating" });
                        void requests
                            .createProject(displayName, signal)
                            .then((project) => {
                                if (!controller.signal.aborted) {
                                    setState({ kind: "ready", project });
                                }
                            })
                            .catch(() => {
                                if (!controller.signal.aborted) {
                                    setState({
                                        kind: "failed",
                                        message: "Could not create your Project. Please try again.",
                                    });
                                }
                            });
                    }}
                >
                    <label className="grid gap-1" htmlFor={nameId}>
                        Project name
                        <Input
                            id={nameId}
                            value={displayName}
                            onChange={(event) => setDisplayName(event.target.value)}
                            required
                            maxLength={120}
                            disabled={state.kind === "creating"}
                        />
                    </label>
                    <Button type="submit" disabled={state.kind === "creating"}>
                        {state.kind === "creating" ? "Creating Project…" : "Create Platform Project"}
                    </Button>
                    {state.kind === "failed" ? (
                        <p role="alert" className="w-full text-sm">
                            {state.message}
                        </p>
                    ) : null}
                </form>
            )}
        </Card>
    );
}
