import { Link } from "@tanstack/react-router";
import { ArrowRight, Hash, MessageSquare } from "lucide-react";
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
    view: selected,
    workspacePath,
}: WorkspaceConnectionProps<TConnection> & {
    readonly ChatApplication: ComponentType<ChatApplicationProps<TConnection>>;
    readonly SlackApplication: ComponentType;
    readonly ProjectsApplication: ComponentType<ProjectApplicationProps>;
}) {
    const connection = initialConnection;
    const [channelId, selectChannel] = useState<string | null>(null);
    const isApplication = selected === "chat" || selected === "slack";
    return (
        <>
            {isApplication ? (
                <section
                    aria-label={selected === "chat" ? "Chat" : "Slack"}
                    className="grid min-h-0 min-w-0 flex-1 motion-safe:animate-cloud-enter"
                >
                    {selected === "slack" ? (
                        <SlackApplication />
                    ) : connection.kind === "connected" ? (
                        <ChatApplication connection={connection.connection} />
                    ) : (
                        <div className="flex flex-col items-start gap-4 self-start rounded-xl border border-border bg-card p-6">
                            <p role="status" className="text-sm text-muted-foreground">
                                Select a paired project in workspace management to open Chat.
                            </p>
                            <Button asChild>
                                <Link to={workspacePath} search={{}}>
                                    Choose a project
                                </Link>
                            </Button>
                        </div>
                    )}
                </section>
            ) : (
                <div className="grid min-w-0 items-start gap-6 motion-safe:animate-cloud-enter lg:grid-cols-[minmax(0,2fr)_minmax(16rem,1fr)]">
                    <section aria-label="Project and bot management" className="min-w-0">
                        <ProjectsApplication onChannelSelected={selectChannel} />
                    </section>
                    <nav aria-label="Workspace applications" className="grid gap-5">
                        <Card asChild>
                            <Link
                                to={`${workspacePath}/chat`}
                                search={channelId === null ? {} : { channel: channelId }}
                                aria-label="Open Chat"
                                className="group p-5 transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                            >
                                <h2 className="flex items-center gap-3 text-sm font-semibold">
                                    <MessageSquare aria-hidden="true" className="size-5 text-primary" /> Chat{" "}
                                    <ArrowRight
                                        aria-hidden="true"
                                        className="ml-auto size-4 text-muted-foreground group-hover:text-foreground"
                                    />
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
                                className="group p-5 transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                            >
                                <h2 className="flex items-center gap-3 text-sm font-semibold">
                                    <Hash aria-hidden="true" className="size-5 text-primary" /> Slack{" "}
                                    <ArrowRight
                                        aria-hidden="true"
                                        className="ml-auto size-4 text-muted-foreground group-hover:text-foreground"
                                    />
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
