import { Link } from "@tanstack/react-router";
import { ArrowRight, MessageSquare } from "lucide-react";
import { type ComponentType, useState } from "react";
import { Card } from "../../components/ui/card.tsx";
import { Button } from "../../components/ui/cloud-button.tsx";
import { NavigationCardLink } from "../../components/ui/navigation-card-link.tsx";
import { Spinner } from "../../components/ui/spinner.tsx";
import type { ApplicationConnectionProps } from "../../view-models/channel-connection.ts";

export interface WorkspaceApplicationProps {
    readonly onChannelSelected: (channelId: string | null) => void;
    readonly userId: string;
}

export interface ChatApplicationProps<TConnection> {
    readonly connection: TConnection;
}

export function MobiusApplications<TConnection>({
    ChatApplication,
    WorkspaceApplication,
    initialConnection,
    view: selected,
    userId,
}: ApplicationConnectionProps<TConnection> & {
    readonly ChatApplication: ComponentType<ChatApplicationProps<TConnection>>;
    readonly WorkspaceApplication: ComponentType<WorkspaceApplicationProps>;
}) {
    const connection = initialConnection;
    const [channelId, selectChannel] = useState<string | null>(null);
    const isApplication = selected === "chat";
    return (
        <>
            {isApplication ? (
                <section aria-label="Chat" className="grid min-h-0 min-w-0 flex-1 motion-safe:animate-cloud-enter">
                    {connection.kind === "connected" ? (
                        <ChatApplication connection={connection.connection} />
                    ) : (
                        <div className="flex flex-col items-start gap-4 self-start rounded-xl border border-border bg-card p-6">
                            <p role="status" className="text-sm text-muted-foreground">
                                Select one of your bots to open Chat.
                            </p>
                            <Button asChild>
                                <Link to="/" search={{}}>
                                    Choose a workspace
                                </Link>
                            </Button>
                        </div>
                    )}
                </section>
            ) : (
                <div className="grid min-w-0 items-start gap-6 motion-safe:animate-cloud-enter lg:grid-cols-[minmax(0,2fr)_minmax(16rem,1fr)]">
                    <section aria-label="Workspace and bot management" className="min-w-0">
                        <WorkspaceApplication userId={userId} onChannelSelected={selectChannel} />
                    </section>
                    <nav aria-label="Applications" className="grid gap-5">
                        <Card asChild>
                            <NavigationCardLink
                                to="/chat"
                                search={channelId === null ? {} : { channel: channelId }}
                                label="Open Chat"
                                className="group p-5 transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                            >
                                {(pending) => (
                                    <>
                                        <h2 className="flex items-center gap-3 text-sm font-semibold">
                                            <MessageSquare aria-hidden="true" className="size-5 text-primary" /> Chat{" "}
                                            <span className="ml-auto">
                                                {pending ? (
                                                    <Spinner label="Opening Chat" />
                                                ) : (
                                                    <ArrowRight
                                                        aria-hidden="true"
                                                        className="ml-auto size-4 text-muted-foreground group-hover:text-foreground"
                                                    />
                                                )}
                                            </span>
                                        </h2>
                                        <p className="mt-2 text-[13px] text-muted-foreground">
                                            Open your local agent conversations.
                                        </p>
                                    </>
                                )}
                            </NavigationCardLink>
                        </Card>
                    </nav>
                </div>
            )}
        </>
    );
}
