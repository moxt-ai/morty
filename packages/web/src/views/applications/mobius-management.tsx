import { useAuth } from "@clerk/react";
import { useEffect, useState } from "react";
import { MobiusChat } from "../../components/chat/mobius-chat.tsx";
import { ChatCloudApi } from "../../services/chat/chat-cloud-api.ts";
import { waitForClerk } from "../../view-models/authentication/session.ts";
import { type ApplicationConnectionProps, BrowserChannelConnection } from "../../view-models/channel-connection.ts";
import { ChannelConnection } from "../../view-models/chat/channel.ts";
import { type ChatApplicationProps, MobiusApplications } from "./application-navigation.tsx";
import { ProjectBotManagement } from "./project-bot-management.tsx";
import { SlackManagement } from "./slack-management.tsx";

function ChatApplication({ connection }: ChatApplicationProps<ChannelConnection>) {
    const { getToken } = useAuth();
    const [activeConnection, setActiveConnection] = useState(connection);
    useEffect(() => {
        const controller = new AbortController();
        const chat = new ChatCloudApi({
            appId: import.meta.env.VITE_MOBIUS_APP_ID,
            origin: window.location.origin,
            getToken: (signal) => waitForClerk(() => getToken(), signal),
            mobiusBaseUrl: import.meta.env.VITE_MOBIUS_BASE_URL,
        });
        let current = connection;
        let regenerating = false;
        setActiveConnection(connection);
        const interval = window.setInterval(
            () => {
                if (regenerating) {
                    return;
                }
                regenerating = true;
                void chat
                    .regenerate(
                        {
                            appId: current.appId,
                            botId: current.channelId,
                            mobiusBaseUrl: current.mobiusBaseUrl,
                            accessToken: current.accessToken,
                            accessTokenId: current.accessTokenId,
                        },
                        controller.signal,
                    )
                    .then((access) => {
                        if (!controller.signal.aborted) {
                            current = new ChannelConnection(
                                current.agents,
                                current.channelId,
                                current.machineName,
                                current.workspaceName,
                                access.accessToken,
                                current.tenantId,
                                current.projectId,
                                current.runtimeId,
                                current.installableAgents,
                                current.mobiusBaseUrl,
                                current.accessTokenId,
                                current.appId,
                            );
                            setActiveConnection(current);
                        }
                    })
                    .catch(() => undefined)
                    .finally(() => {
                        regenerating = false;
                    });
            },
            5 * 60 * 1_000,
        );
        return () => {
            window.clearInterval(interval);
            controller.abort();
            void chat
                .revoke(
                    {
                        appId: current.appId,
                        botId: current.channelId,
                        mobiusBaseUrl: current.mobiusBaseUrl,
                        accessToken: current.accessToken,
                        accessTokenId: current.accessTokenId,
                    },
                    AbortSignal.timeout(10_000),
                )
                .catch(() => undefined);
        };
    }, [connection, getToken]);
    return <MobiusChat connection={activeConnection} />;
}

function SlackApplication({ userId }: { readonly userId: string }) {
    return <SlackManagement userId={userId} />;
}

export function userBotConnection(userId: string, getToken: (signal: AbortSignal) => Promise<string | null>) {
    const chat = new ChatCloudApi({
        appId: import.meta.env.VITE_MOBIUS_APP_ID,
        origin: window.location.origin,
        getToken,
        mobiusBaseUrl: import.meta.env.VITE_MOBIUS_BASE_URL,
    });
    return new BrowserChannelConnection(userId, window.localStorage, async (botId, signal) => {
        const access = await chat.open(botId, signal);
        return new ChannelConnection(
            [],
            botId,
            "Mobius",
            "",
            access.accessToken,
            userId,
            botId,
            botId,
            [],
            access.mobiusBaseUrl,
            access.accessTokenId,
            access.appId,
        );
    });
}

export function MobiusManagement(props: ApplicationConnectionProps<ChannelConnection>) {
    return (
        <MobiusApplications
            {...props}
            ChatApplication={ChatApplication}
            SlackApplication={SlackApplication}
            ProjectsApplication={ProjectBotManagement}
        />
    );
}
