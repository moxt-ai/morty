import { useAuth } from "@clerk/react";
import { MobiusSlackContext } from "@moxt-ai/app-slack-web-core";
import { type ChannelConnection, MobiusChat, Pair, readChannelConnection } from "@moxt-ai/mobius-web-core";
import { useCallback } from "react";
import { waitForClerk } from "../../view-models/workspaces/clerk-directory.ts";
import {
    BrowserWorkspaceConnections,
    type WorkspaceConnectionProps,
} from "../../view-models/workspaces/connections.ts";
import { SlackManagement } from "./slack-management.tsx";
import {
    type ChatApplicationProps,
    type PairApplicationProps,
    type SlackApplicationProps,
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

function SlackApplication({ connection }: SlackApplicationProps<ChannelConnection>) {
    return <SlackManagement connection={connection} />;
}

export function mobiusWorkspaceConnections(userId: string) {
    return new BrowserWorkspaceConnections(userId, window.localStorage, readChannelConnection);
}

export function MobiusManagement(props: WorkspaceConnectionProps<ChannelConnection>) {
    return (
        <MobiusSlackContext context={{ mobiusUrl: window.location.origin }}>
            <WorkspaceApplications
                {...props}
                ChatApplication={ChatApplication}
                PairApplication={PairApplication}
                SlackApplication={SlackApplication}
            />
        </MobiusSlackContext>
    );
}
