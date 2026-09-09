import { Link, useRouterState } from "@tanstack/react-router";
import { type ComponentType, useState } from "react";
import type { WorkspaceConnectionProps } from "../../view-models/workspaces/connections.ts";

export interface PairApplicationProps<TConnection> {
    readonly onConnected: (connection: TConnection) => void;
}

export interface ChatApplicationProps<TConnection> {
    readonly connection: TConnection;
}

export function WorkspaceApplications<TConnection>({
    ChatApplication,
    PairApplication,
    SlackApplication,
    ProjectsApplication,
    initialConnection,
    onConnected,
}: WorkspaceConnectionProps<TConnection> & {
    readonly ChatApplication: ComponentType<ChatApplicationProps<TConnection>>;
    readonly PairApplication: ComponentType<PairApplicationProps<TConnection>>;
    readonly SlackApplication: ComponentType;
    readonly ProjectsApplication: ComponentType;
}) {
    const [connection, setConnection] = useState(initialConnection);
    const [failure, setFailure] = useState<string | null>(null);
    const location = useRouterState({ select: (state) => state.location });
    const selected = location.pathname.endsWith("/chat")
        ? "chat"
        : location.pathname.endsWith("/slack")
          ? "slack"
          : "overview";
    const workspacePath =
        selected === "overview" ? location.pathname : location.pathname.slice(0, location.pathname.lastIndexOf("/"));
    const isApplication = selected === "chat" || selected === "slack";
    return (
        <>
            {failure !== null && <p role="alert">{failure}</p>}
            {isApplication ? (
                <section aria-label={selected === "chat" ? "Chat" : "Slack"} className="grid min-w-0 gap-5">
                    <header className="flex items-center justify-between gap-4">
                        <h2 className="text-xl font-semibold">{selected === "chat" ? "Chat" : "Slack"}</h2>
                        <Link
                            to={workspacePath}
                            search={{}}
                            className="text-sm font-medium text-emerald-700 hover:underline"
                        >
                            Back to workspace
                        </Link>
                    </header>
                    {selected === "slack" ? (
                        <SlackApplication />
                    ) : connection.kind === "connected" ? (
                        <ChatApplication connection={connection.connection} />
                    ) : (
                        <PairApplication
                            onConnected={(paired) => {
                                try {
                                    onConnected(paired);
                                    setFailure(null);
                                    setConnection({ kind: "connected", connection: paired });
                                } catch {
                                    setFailure(
                                        "This browser could not save the machine connection. Allow site storage and try again.",
                                    );
                                }
                            }}
                        />
                    )}
                </section>
            ) : (
                <div className="grid min-w-0 items-start gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(16rem,1fr)]">
                    <section aria-label="Project and bot management" className="min-w-0">
                        <ProjectsApplication />
                    </section>
                    <nav aria-label="Workspace applications" className="grid gap-5">
                        <Link
                            to={`${workspacePath}/chat`}
                            search={{}}
                            aria-label="Open Chat"
                            className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm transition hover:border-emerald-500 hover:shadow-md focus-visible:outline-2 focus-visible:outline-emerald-600"
                        >
                            <h2 className="text-xl font-semibold">
                                Chat <span aria-hidden="true">↗</span>
                            </h2>
                            <p className="mt-2 text-sm text-zinc-500">Open your local agent conversations.</p>
                        </Link>
                        <Link
                            to={`${workspacePath}/slack`}
                            search={{}}
                            aria-label="Open Slack"
                            className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm transition hover:border-emerald-500 hover:shadow-md focus-visible:outline-2 focus-visible:outline-emerald-600"
                        >
                            <h2 className="text-xl font-semibold">
                                Slack <span aria-hidden="true">↗</span>
                            </h2>
                            <p className="mt-2 text-sm text-zinc-500">
                                Manage Slack bots, installations, and bindings.
                            </p>
                        </Link>
                    </nav>
                </div>
            )}
        </>
    );
}
