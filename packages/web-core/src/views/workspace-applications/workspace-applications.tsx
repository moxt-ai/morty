import { Link, useRouterState } from "@tanstack/react-router";
import { type ComponentType, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { Card } from "../../components/ui/card.tsx";
import type { WorkspaceConnectionProps } from "../../view-models/workspaces/connections.ts";

export interface ProjectApplicationProps {
    readonly onChannelSelected: (channelId: string | null) => void;
}

export interface ChatApplicationProps<TConnection> {
    readonly connection: TConnection;
}

export function WorkspaceApplications<TConnection>({
    ChatApplication,
    SlackApplication,
    ProjectsApplication,
    initialConnection,
}: WorkspaceConnectionProps<TConnection> & {
    readonly ChatApplication: ComponentType<ChatApplicationProps<TConnection>>;
    readonly SlackApplication: ComponentType;
    readonly ProjectsApplication: ComponentType<ProjectApplicationProps>;
}) {
    const connection = initialConnection;
    const [channelId, selectChannel] = useState<string | null>(null);
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
            {isApplication ? (
                <section aria-label={selected === "chat" ? "Chat" : "Slack"} className="grid min-w-0 gap-5">
                    <header className="flex items-center justify-between gap-4">
                        <h2 className="text-xl font-semibold">{selected === "chat" ? "Chat" : "Slack"}</h2>
                        <Button asChild variant="outline">
                            <Link to={workspacePath} search={{}}>
                                Back to workspace
                            </Link>
                        </Button>
                    </header>
                    {selected === "slack" ? (
                        <SlackApplication />
                    ) : connection.kind === "connected" ? (
                        <ChatApplication connection={connection.connection} />
                    ) : (
                        <p role="status" className="text-sm text-muted-foreground">
                            Select a paired project in workspace management to open Chat.
                        </p>
                    )}
                </section>
            ) : (
                <div className="grid min-w-0 items-start gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(16rem,1fr)]">
                    <section aria-label="Project and bot management" className="min-w-0">
                        <ProjectsApplication onChannelSelected={selectChannel} />
                    </section>
                    <nav aria-label="Workspace applications" className="grid gap-5">
                        <Card asChild>
                            <Link
                                to={`${workspacePath}/chat`}
                                search={channelId === null ? {} : { channel: channelId }}
                                aria-label="Open Chat"
                                className="p-5 transition-colors hover:border-ring hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                            >
                                <h2 className="text-base font-semibold">
                                    Chat <span aria-hidden="true">↗</span>
                                </h2>
                                <p className="mt-2 text-[13px] text-muted-foreground">
                                    Open your local agent conversations.
                                </p>
                            </Link>
                        </Card>
                        <Card asChild>
                            <Link
                                to={`${workspacePath}/slack`}
                                search={{}}
                                aria-label="Open Slack"
                                className="p-5 transition-colors hover:border-ring hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                            >
                                <h2 className="text-base font-semibold">
                                    Slack <span aria-hidden="true">↗</span>
                                </h2>
                                <p className="mt-2 text-[13px] text-muted-foreground">
                                    Manage Slack bots, installations, and bindings.
                                </p>
                            </Link>
                        </Card>
                    </nav>
                </div>
            )}
        </>
    );
}
