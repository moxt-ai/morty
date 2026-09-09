import { type ChannelConnection, MobiusChat, readChannelConnection } from "@moxt-ai/mobius-web-core";
import {
    BrowserWorkspaceConnections,
    type WorkspaceConnectionProps,
} from "../../view-models/workspaces/connections.ts";
import { ProjectBotManagement } from "./project-bot-management.tsx";
import { SlackManagement } from "./slack-management.tsx";
import { type ChatApplicationProps, WorkspaceApplications } from "./workspace-applications.tsx";

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
            SlackApplication={SlackApplication}
            ProjectsApplication={ProjectBotManagement}
        />
    );
}
