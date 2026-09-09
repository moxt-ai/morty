import { useAuth } from "@clerk/react";
import { type ChannelConnection, MobiusChat, Pair, readChannelConnection } from "@moxt-ai/mobius-web-core";
import { useCallback } from "react";
import { waitForClerk } from "../../view-models/workspaces/clerk-directory.ts";
import {
    BrowserWorkspaceConnections,
    type WorkspaceConnectionProps,
} from "../../view-models/workspaces/connections.ts";
import { ProjectBotManagement, SlackManagement } from "./slack-management.tsx";
import {
    type ChatApplicationProps,
    type PairApplicationProps,
    WorkspaceApplications,
} from "./workspace-applications.tsx";

function PairApplication({ onConnected }: PairApplicationProps<ChannelConnection>) {
    const { getToken, isLoaded, orgId } = useAuth();
    const getPairingToken = useCallback(
        async (signal: AbortSignal) => {
            const token = await waitForClerk(() => getToken(), signal);
            if (token === null) {
                throw new Error("Sign in to pair a machine.");
            }
            return token;
        },
        [getToken],
    );
    if (!isLoaded) {
        return <p role="status">Loading workspace…</p>;
    }
    if (!orgId) {
        return <p role="alert">Select this workspace to pair a machine.</p>;
    }
    return <Pair key={orgId} onConnected={onConnected} getPairingToken={getPairingToken} />;
}

function ChatApplication({ connection }: ChatApplicationProps<ChannelConnection>) {
    return <MobiusChat connection={connection} />;
}

function SlackApplication() {
    return <SlackManagement />;
}

export function mobiusWorkspaceConnections(userId: string) {
    return new BrowserWorkspaceConnections(userId, window.localStorage, readChannelConnection);
}

export function MobiusManagement(props: WorkspaceConnectionProps<ChannelConnection>) {
    return (
        <WorkspaceApplications
            {...props}
            ChatApplication={ChatApplication}
            PairApplication={PairApplication}
            SlackApplication={SlackApplication}
            ProjectsApplication={ProjectBotManagement}
        />
    );
}
